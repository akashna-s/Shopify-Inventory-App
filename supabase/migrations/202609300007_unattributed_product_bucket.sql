-- Preserve ShopifyQL rows that have no usable Product ID in one clearly
-- identified synthetic product per store. This row is for reconciliation; it
-- must never be treated as a real Shopify product or lifecycle candidate.

alter table public.audit_products
  add column if not exists record_kind text not null default 'shopify';

alter table public.audit_products
  alter column shopify_product_id drop not null,
  drop constraint if exists audit_products_record_kind_check,
  drop constraint if exists audit_products_identity_by_kind_check;

alter table public.audit_products
  add constraint audit_products_record_kind_check
    check (record_kind in ('shopify', 'unattributed')),
  add constraint audit_products_identity_by_kind_check
    check (
      (record_kind = 'shopify' and shopify_product_id is not null)
      or (record_kind = 'unattributed' and shopify_product_id is null)
    );

create unique index if not exists audit_products_one_unattributed_per_store_idx
  on public.audit_products (store_id)
  where record_kind = 'unattributed';

comment on column public.audit_products.record_kind is
  'shopify for a real catalogue product; unattributed for the single per-store bucket used when ShopifyQL supplies no Product ID.';

create or replace function public.ensure_audit_unattributed_product(
  p_store_id bigint
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product_id bigint;
begin
  if p_store_id is null then raise exception 'store_id is required'; end if;
  if not exists (select 1 from public.audit_stores where id = p_store_id) then
    raise exception 'unknown store_id %', p_store_id;
  end if;

  insert into public.audit_products (
    store_id, shopify_product_id, title, handle, product_type, status,
    image_url, record_kind, catalog_state, last_seen_at, missing_since,
    deleted_at, last_synced_at
  ) values (
    p_store_id, null, 'Unattributed Shopify Data', '', 'Unknown',
    'UNATTRIBUTED', '', 'unattributed', 'present', now(), null, null, now()
  )
  on conflict (store_id) where record_kind = 'unattributed'
  do update set
    title = excluded.title,
    handle = '',
    product_type = 'Unknown',
    status = 'UNATTRIBUTED',
    image_url = '',
    catalog_state = 'present',
    last_seen_at = excluded.last_seen_at,
    missing_since = null,
    deleted_at = null,
    last_synced_at = excluded.last_synced_at
  returning id into v_product_id;

  return v_product_id;
end;
$$;

-- Create the protected bucket for stores that already exist.
insert into public.audit_products (
  store_id, shopify_product_id, title, handle, product_type, status,
  image_url, record_kind, catalog_state, last_seen_at, last_synced_at
)
select
  store.id, null, 'Unattributed Shopify Data', '', 'Unknown',
  'UNATTRIBUTED', '', 'unattributed', 'present', now(), now()
from public.audit_stores store
on conflict (store_id) where record_kind = 'unattributed' do nothing;

create or replace function public.reconcile_audit_product_catalog(
  p_store_id bigint,
  p_seen_product_ids text[],
  p_seen_at timestamptz
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated integer := 0;
  v_count integer := 0;
begin
  if p_store_id is null then raise exception 'store_id is required'; end if;
  if p_seen_product_ids is null then raise exception 'seen product IDs are required'; end if;
  if p_seen_at is null then raise exception 'seen_at is required'; end if;
  if exists (
    select 1 from unnest(p_seen_product_ids) id
    where id is null or id !~ '^[0-9]+$'
  ) then
    raise exception 'Shopify product IDs must be decimal text';
  end if;
  if not exists (select 1 from public.audit_stores where id = p_store_id) then
    raise exception 'unknown store_id %', p_store_id;
  end if;

  update public.audit_products
  set
    catalog_state = 'present',
    last_seen_at = p_seen_at,
    missing_since = null,
    deleted_at = null
  where store_id = p_store_id
    and record_kind = 'shopify'
    and shopify_product_id = any(p_seen_product_ids);
  get diagnostics v_updated = row_count;

  update public.audit_products
  set
    catalog_state = 'missing',
    missing_since = coalesce(missing_since, p_seen_at)
  where store_id = p_store_id
    and record_kind = 'shopify'
    and catalog_state <> 'deleted'
    and not (shopify_product_id = any(p_seen_product_ids));
  get diagnostics v_count = row_count;

  return v_updated + v_count;
end;
$$;

create or replace function public.mark_audit_product_deleted(
  p_store_id bigint,
  p_shopify_product_id text,
  p_deleted_at timestamptz
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if p_store_id is null then raise exception 'store_id is required'; end if;
  if p_shopify_product_id is null or p_shopify_product_id !~ '^[0-9]+$' then
    raise exception 'shopify_product_id must be decimal text';
  end if;
  if p_deleted_at is null then raise exception 'deleted_at is required'; end if;

  update public.audit_products
  set
    catalog_state = 'deleted',
    missing_since = coalesce(missing_since, p_deleted_at),
    deleted_at = coalesce(deleted_at, p_deleted_at),
    last_synced_at = p_deleted_at
  where store_id = p_store_id
    and record_kind = 'shopify'
    and shopify_product_id = p_shopify_product_id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.cleanup_audit_orphan_products(
  p_store_id bigint,
  p_grace_before timestamptz
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if p_store_id is null then raise exception 'store_id is required'; end if;
  if p_grace_before is null then raise exception 'grace boundary is required'; end if;

  delete from public.audit_products product
  where product.store_id = p_store_id
    and product.record_kind = 'shopify'
    and product.catalog_state in ('missing', 'deleted')
    and coalesce(product.deleted_at, product.missing_since) < p_grace_before
    and not exists (
      select 1
      from public.audit_product_month_metrics metric
      where metric.store_id = p_store_id
        and metric.product_id = product.id
    );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

drop view if exists public.audit_products_with_effective_status;

create view public.audit_products_with_effective_status
with (security_invoker = true)
as
select
  product.*,
  case
    when product.record_kind = 'unattributed' then 'UNATTRIBUTED'
    when product.catalog_state = 'deleted' then 'DELETED'
    when product.catalog_state = 'missing' then 'MISSING'
    else upper(coalesce(nullif(product.status, ''), 'UNKNOWN'))
  end as effective_status
from public.audit_products product;

revoke all on function public.ensure_audit_unattributed_product(bigint)
  from public, anon, authenticated;
grant execute on function public.ensure_audit_unattributed_product(bigint)
  to service_role;

revoke all on function public.reconcile_audit_product_catalog(bigint, text[], timestamptz)
  from public, anon, authenticated;
revoke all on function public.mark_audit_product_deleted(bigint, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.cleanup_audit_orphan_products(bigint, timestamptz)
  from public, anon, authenticated;
grant execute on function public.reconcile_audit_product_catalog(bigint, text[], timestamptz)
  to service_role;
grant execute on function public.mark_audit_product_deleted(bigint, text, timestamptz)
  to service_role;
grant execute on function public.cleanup_audit_orphan_products(bigint, timestamptz)
  to service_role;

revoke all on table public.audit_products_with_effective_status
  from public, anon, authenticated;
grant select on table public.audit_products_with_effective_status to service_role;

notify pgrst, 'reload schema';
