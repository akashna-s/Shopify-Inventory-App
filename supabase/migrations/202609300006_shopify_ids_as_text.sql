-- Shopify IDs are externally owned unsigned identifiers. Store them as decimal
-- text so JavaScript and JSON can never round a future value above 2^53 - 1.
-- Internal audit_stores.id and audit_products.id keys intentionally stay bigint.

drop view if exists public.audit_product_handle_history_with_product;
drop view if exists public.audit_products_with_effective_status;

drop function if exists public.reconcile_audit_product_catalog(bigint, bigint[], timestamptz);
drop function if exists public.mark_audit_product_deleted(bigint, bigint, timestamptz);

alter table public.audit_products
  alter column shopify_product_id type text
  using shopify_product_id::text;

alter table public.audit_products
  drop constraint if exists audit_products_shopify_product_id_text_check;
alter table public.audit_products
  add constraint audit_products_shopify_product_id_text_check
    check (shopify_product_id ~ '^[0-9]+$');

comment on column public.audit_products.shopify_product_id is
  'Shopify Product ID stored as decimal text to preserve the complete unsigned identifier in JavaScript and JSON.';

create or replace view public.audit_products_with_effective_status
with (security_invoker = true)
as
select
  product.*,
  case product.catalog_state
    when 'deleted' then 'DELETED'
    when 'missing' then 'MISSING'
    else upper(coalesce(nullif(product.status, ''), 'UNKNOWN'))
  end as effective_status
from public.audit_products product;

create or replace view public.audit_product_handle_history_with_product
with (security_invoker = true)
as
select
  history.id,
  history.store_id,
  history.product_id,
  product.shopify_product_id,
  history.handle,
  history.valid_from,
  history.valid_to,
  history.last_seen_at
from public.audit_product_handle_history history
join public.audit_products product
  on product.id = history.product_id
 and product.store_id = history.store_id;

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
    and shopify_product_id = any(p_seen_product_ids);
  get diagnostics v_updated = row_count;

  update public.audit_products
  set
    catalog_state = 'missing',
    missing_since = coalesce(missing_since, p_seen_at)
  where store_id = p_store_id
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
    and shopify_product_id = p_shopify_product_id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.reconcile_audit_product_handles(
  p_store_id bigint,
  p_handles jsonb,
  p_seen_at timestamptz
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  product_record record;
  current_record record;
  incoming_product_id text;
  incoming_handle text;
  initial_valid_from timestamptz;
  changed integer := 0;
begin
  if p_store_id is null then raise exception 'store_id is required'; end if;
  if jsonb_typeof(coalesce(p_handles, 'null'::jsonb)) <> 'array' then
    raise exception 'handles must be a JSON array';
  end if;
  if p_seen_at is null then raise exception 'seen_at is required'; end if;

  for item in select value from jsonb_array_elements(p_handles)
  loop
    incoming_product_id := trim(coalesce(item->>'shopify_product_id', ''));
    incoming_handle := lower(trim(coalesce(item->>'handle', '')));
    if incoming_product_id !~ '^[0-9]+$' then
      raise exception 'Shopify product ID must be decimal text';
    end if;
    if incoming_handle = '' then continue; end if;

    select id, shopify_created_at into product_record
    from public.audit_products
    where store_id = p_store_id
      and shopify_product_id = incoming_product_id;
    if not found then
      raise exception 'product % does not belong to store_id %', incoming_product_id, p_store_id;
    end if;

    select id, handle into current_record
    from public.audit_product_handle_history
    where store_id = p_store_id
      and product_id = product_record.id
      and valid_to is null
    limit 1;

    if not found then
      initial_valid_from := coalesce(
        nullif(item->>'valid_from', '')::timestamptz,
        product_record.shopify_created_at,
        p_seen_at
      );
      insert into public.audit_product_handle_history(
        store_id, product_id, handle, valid_from, last_seen_at
      ) values (
        p_store_id, product_record.id, incoming_handle, initial_valid_from, p_seen_at
      );
      changed := changed + 1;
    elsif current_record.handle = incoming_handle then
      update public.audit_product_handle_history
      set last_seen_at = p_seen_at
      where id = current_record.id;
      changed := changed + 1;
    else
      update public.audit_product_handle_history
      set valid_to = p_seen_at, last_seen_at = p_seen_at
      where id = current_record.id;
      insert into public.audit_product_handle_history(
        store_id, product_id, handle, valid_from, last_seen_at
      ) values (
        p_store_id, product_record.id, incoming_handle, p_seen_at, p_seen_at
      );
      changed := changed + 2;
    end if;
  end loop;
  return changed;
end;
$$;

revoke all on table public.audit_products_with_effective_status
  from public, anon, authenticated;
revoke all on table public.audit_product_handle_history_with_product
  from public, anon, authenticated;
grant select on table public.audit_products_with_effective_status to service_role;
grant select on table public.audit_product_handle_history_with_product to service_role;

revoke all on function public.reconcile_audit_product_catalog(bigint, text[], timestamptz)
  from public, anon, authenticated;
revoke all on function public.mark_audit_product_deleted(bigint, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.reconcile_audit_product_handles(bigint, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.reconcile_audit_product_catalog(bigint, text[], timestamptz)
  to service_role;
grant execute on function public.mark_audit_product_deleted(bigint, text, timestamptz)
  to service_role;
grant execute on function public.reconcile_audit_product_handles(bigint, jsonb, timestamptz)
  to service_role;

notify pgrst, 'reload schema';
