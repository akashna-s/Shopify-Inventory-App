-- Preserve historical product facts while distinguishing current catalogue
-- presence from the last Shopify status reported for a product.

alter table public.audit_products
  add column if not exists catalog_state text not null default 'present',
  add column if not exists last_seen_at timestamptz,
  add column if not exists missing_since timestamptz,
  add column if not exists deleted_at timestamptz;

update public.audit_products
set
  catalog_state = 'present',
  last_seen_at = coalesce(last_seen_at, last_synced_at, now())
where last_seen_at is null;

alter table public.audit_products
  drop constraint if exists audit_products_catalog_state_check;

alter table public.audit_products
  add constraint audit_products_catalog_state_check
    check (catalog_state in ('present', 'missing', 'deleted'));

create index if not exists audit_products_store_catalog_state_idx
  on public.audit_products (store_id, catalog_state, last_seen_at);

comment on column public.audit_products.status is
  'Last Shopify product status: ACTIVE, DRAFT or ARCHIVED. Lifecycle state takes precedence for display and filtering.';
comment on column public.audit_products.catalog_state is
  'Current catalogue lifecycle: present, missing after a successful full sync, or webhook-confirmed deleted.';
comment on column public.audit_products.last_seen_at is
  'Last successful full catalogue sync that returned this product.';
comment on column public.audit_products.missing_since is
  'First successful full catalogue sync that did not return this product.';
comment on column public.audit_products.deleted_at is
  'Deletion time confirmed by Shopify webhook or a definitive product lookup.';

create or replace function public.reconcile_audit_product_catalog(
  p_store_id bigint,
  p_seen_product_ids bigint[],
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
  p_shopify_product_id bigint,
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
  if p_shopify_product_id is null then raise exception 'shopify_product_id is required'; end if;
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

revoke all on function public.reconcile_audit_product_catalog(bigint, bigint[], timestamptz)
  from public, anon, authenticated;
revoke all on function public.mark_audit_product_deleted(bigint, bigint, timestamptz)
  from public, anon, authenticated;
revoke all on function public.cleanup_audit_orphan_products(bigint, timestamptz)
  from public, anon, authenticated;
grant execute on function public.reconcile_audit_product_catalog(bigint, bigint[], timestamptz)
  to service_role;
grant execute on function public.mark_audit_product_deleted(bigint, bigint, timestamptz)
  to service_role;
grant execute on function public.cleanup_audit_orphan_products(bigint, timestamptz)
  to service_role;

revoke all on table public.audit_products_with_effective_status
  from public, anon, authenticated;
grant select on table public.audit_products_with_effective_status to service_role;
