-- Assign every store one stable analytics storage mode before report data is
-- written. New stores use the database only while projected mature usage stays
-- within the configured 80% soft limit. Existing assignments never change
-- automatically; movement requires the explicit migration function below.

alter table public.audit_stores
  add column if not exists storage_mode text not null default 'database',
  add column if not exists storage_mode_assigned_at timestamptz not null default now(),
  add column if not exists projected_storage_bytes bigint not null default 8000000,
  add column if not exists storage_assignment_reason text not null default 'existing_database_store';

alter table public.audit_stores
  drop constraint if exists audit_stores_storage_mode_check,
  drop constraint if exists audit_stores_projected_storage_bytes_check;

alter table public.audit_stores
  add constraint audit_stores_storage_mode_check
    check (storage_mode in ('database', 'file_cache')),
  add constraint audit_stores_projected_storage_bytes_check
    check (projected_storage_bytes >= 0);

-- Seed existing stores conservatively from their current Shopify product count.
-- 15 KB per product is based on the measured mature 18-month physical footprint;
-- 8 MB prevents tiny stores from being treated as free.
update public.audit_stores store
set projected_storage_bytes = greatest(
      store.projected_storage_bytes,
      8000000::bigint,
      coalesce((
        select count(*) * 15000::bigint
        from public.audit_products product
        where product.store_id = store.id
          and product.record_kind = 'shopify'
      ), 0)
    ),
    storage_mode = coalesce(store.storage_mode, 'database'),
    storage_mode_assigned_at = coalesce(store.storage_mode_assigned_at, store.created_at, now()),
    storage_assignment_reason = case
      when coalesce(store.storage_assignment_reason, '') = ''
        then 'existing_database_store'
      else store.storage_assignment_reason
    end;

comment on column public.audit_stores.storage_mode is
  'Fixed analytics storage assignment. Automatic onboarding never changes an existing value.';
comment on column public.audit_stores.projected_storage_bytes is
  'Reserved estimate for this store at a mature rolling 18-month window.';
comment on column public.audit_stores.storage_assignment_reason is
  'Short explanation of the automatic assignment or later explicit migration.';

-- Prevent future server code from bypassing the fixed assignment functions
-- with a direct REST insert or update. Reads and cascade deletes remain as
-- previously granted to the server-only service role.
revoke insert, update on table public.audit_stores from service_role;

create or replace function public.assign_audit_store_storage(
  p_shop_domain text,
  p_currency_code varchar,
  p_iana_timezone text,
  p_projected_storage_bytes bigint,
  p_database_limit_bytes bigint default 500000000,
  p_soft_limit_percent integer default 80,
  p_database_baseline_bytes bigint default 15000000
)
returns table (
  id bigint,
  shop_domain text,
  currency_code varchar,
  iana_timezone text,
  status text,
  storage_mode text,
  storage_mode_assigned_at timestamptz,
  projected_storage_bytes bigint,
  storage_assignment_reason text,
  existing_assignment boolean,
  database_bytes bigint,
  soft_limit_bytes bigint,
  projected_database_bytes bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store public.audit_stores%rowtype;
  v_database_bytes bigint;
  v_soft_limit_bytes bigint;
  v_reserved_database_bytes bigint;
  v_projected_database_bytes bigint;
  v_storage_mode text;
  v_reason text;
  v_shop_domain text := lower(trim(coalesce(p_shop_domain, '')));
  v_projected_storage_bytes bigint := greatest(coalesce(p_projected_storage_bytes, 0), 8000000);
begin
  if v_shop_domain = '' then
    raise exception 'A shop domain is required for storage assignment.';
  end if;
  if p_database_limit_bytes <= 0 then
    raise exception 'Database limit bytes must be positive.';
  end if;
  if p_soft_limit_percent < 1 or p_soft_limit_percent > 99 then
    raise exception 'Database soft-limit percent must be between 1 and 99.';
  end if;
  if p_database_baseline_bytes < 0 then
    raise exception 'Database baseline bytes cannot be negative.';
  end if;

  -- Serialize capacity decisions so two simultaneous installations cannot both
  -- reserve the final available space.
  perform pg_advisory_xact_lock(hashtext('audit_store_storage_assignment'));

  select *
  into v_store
  from public.audit_stores store
  where store.shop_domain = v_shop_domain
  for update;

  v_database_bytes := pg_database_size(current_database());
  v_soft_limit_bytes := floor(
    p_database_limit_bytes::numeric * p_soft_limit_percent::numeric / 100
  )::bigint;

  if found then
    -- Fixed assignment: refresh ordinary store metadata and increase its
    -- reservation when the catalogue grows, but never change storage_mode.
    update public.audit_stores store
    set currency_code = upper(coalesce(nullif(trim(p_currency_code), ''), store.currency_code)),
        iana_timezone = coalesce(nullif(trim(p_iana_timezone), ''), store.iana_timezone),
        status = 'active',
        uninstalled_at = null,
        projected_storage_bytes = greatest(
          store.projected_storage_bytes,
          v_projected_storage_bytes
        ),
        updated_at = now()
    where store.id = v_store.id
    returning * into v_store;

    select coalesce(sum(store.projected_storage_bytes), 0)
    into v_reserved_database_bytes
    from public.audit_stores store
    where store.storage_mode = 'database';

    v_projected_database_bytes := greatest(
      v_database_bytes,
      p_database_baseline_bytes + v_reserved_database_bytes
    );

    return query select
      v_store.id,
      v_store.shop_domain,
      v_store.currency_code,
      v_store.iana_timezone,
      v_store.status,
      v_store.storage_mode,
      v_store.storage_mode_assigned_at,
      v_store.projected_storage_bytes,
      v_store.storage_assignment_reason,
      true,
      v_database_bytes,
      v_soft_limit_bytes,
      v_projected_database_bytes;
    return;
  end if;

  select coalesce(sum(store.projected_storage_bytes), 0)
  into v_reserved_database_bytes
  from public.audit_stores store
  where store.storage_mode = 'database';

  v_projected_database_bytes := greatest(
    v_database_bytes,
    p_database_baseline_bytes + v_reserved_database_bytes
  ) + v_projected_storage_bytes;

  if v_projected_database_bytes <= v_soft_limit_bytes then
    v_storage_mode := 'database';
    v_reason := 'within_projected_80_percent_capacity';
  else
    v_storage_mode := 'file_cache';
    v_reason := 'projected_80_percent_capacity_exceeded';
  end if;

  insert into public.audit_stores (
    shop_domain,
    currency_code,
    iana_timezone,
    status,
    storage_mode,
    storage_mode_assigned_at,
    projected_storage_bytes,
    storage_assignment_reason,
    updated_at
  ) values (
    v_shop_domain,
    upper(coalesce(nullif(trim(p_currency_code), ''), 'USD')),
    coalesce(nullif(trim(p_iana_timezone), ''), 'Etc/UTC'),
    'active',
    v_storage_mode,
    now(),
    v_projected_storage_bytes,
    v_reason,
    now()
  )
  returning * into v_store;

  return query select
    v_store.id,
    v_store.shop_domain,
    v_store.currency_code,
    v_store.iana_timezone,
    v_store.status,
    v_store.storage_mode,
    v_store.storage_mode_assigned_at,
    v_store.projected_storage_bytes,
    v_store.storage_assignment_reason,
    false,
    v_database_bytes,
    v_soft_limit_bytes,
    v_projected_database_bytes;
end;
$$;

create or replace function public.set_audit_store_storage_mode(
  p_store_id bigint,
  p_storage_mode text,
  p_reason text default 'manual_migration'
)
returns public.audit_stores
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store public.audit_stores%rowtype;
begin
  if p_storage_mode not in ('database', 'file_cache') then
    raise exception 'Storage mode must be database or file_cache.';
  end if;

  update public.audit_stores store
  set storage_mode = p_storage_mode,
      storage_mode_assigned_at = now(),
      storage_assignment_reason = coalesce(nullif(trim(p_reason), ''), 'manual_migration'),
      updated_at = now()
  where store.id = p_store_id
  returning * into v_store;

  if not found then
    raise exception 'Store % does not exist.', p_store_id;
  end if;
  return v_store;
end;
$$;

revoke all on function public.assign_audit_store_storage(
  text, varchar, text, bigint, bigint, integer, bigint
) from public, anon, authenticated;
grant execute on function public.assign_audit_store_storage(
  text, varchar, text, bigint, bigint, integer, bigint
) to service_role;

revoke all on function public.set_audit_store_storage_mode(bigint, text, text)
  from public, anon, authenticated;
grant execute on function public.set_audit_store_storage_mode(bigint, text, text)
  to service_role;

comment on function public.assign_audit_store_storage(
  text, varchar, text, bigint, bigint, integer, bigint
) is 'Atomically assigns a fixed database/file-cache mode using projected 18-month capacity and an 80% soft limit.';
comment on function public.set_audit_store_storage_mode(bigint, text, text)
  is 'Explicit administrative migration path; normal onboarding never changes an existing assignment.';
