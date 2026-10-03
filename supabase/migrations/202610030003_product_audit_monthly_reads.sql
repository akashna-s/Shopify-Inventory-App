-- Make monthly Product Audit reads complete and storage-neutral. Versioned
-- coverage fields prevent a report from using an old or partly refreshed month.

alter table public.audit_product_month_metrics
  add column if not exists completed_checkout_sessions bigint not null default 0;

alter table public.audit_store_month_metrics
  add column if not exists source_range_start date,
  add column if not exists source_range_end date,
  add column if not exists cache_schema_version integer not null default 0;

alter table public.audit_store_month_metrics
  drop constraint if exists audit_store_month_metrics_source_range_check;

alter table public.audit_store_month_metrics
  add constraint audit_store_month_metrics_source_range_check
  check (
    (source_range_start is null and source_range_end is null)
    or (
      source_range_start is not null
      and source_range_end is not null
      and source_range_start <= source_range_end
      and date_trunc('month', source_range_start)::date = month
      and date_trunc('month', source_range_end)::date = month
    )
  );

comment on column public.audit_product_month_metrics.completed_checkout_sessions is
  'Product landing sessions that completed checkout; used for Product Audit conversion reporting.';
comment on column public.audit_store_month_metrics.source_range_start is
  'First Shopify calendar day included in this stored month.';
comment on column public.audit_store_month_metrics.source_range_end is
  'Last Shopify calendar day included in this stored month.';
comment on column public.audit_store_month_metrics.cache_schema_version is
  'Monthly cache contract version. Product Audit reads only a version it understands.';

create or replace function public.replace_audit_store_month_v2(
  p_store_id bigint,
  p_month date,
  p_product_metrics jsonb,
  p_store_metrics jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  v_count := public.replace_audit_store_month(
    p_store_id, p_month, p_product_metrics, p_store_metrics
  );

  update public.audit_product_month_metrics metric
  set completed_checkout_sessions = coalesce(incoming.completed_checkout_sessions, 0)
  from jsonb_to_recordset(p_product_metrics) as incoming(
    product_id bigint,
    completed_checkout_sessions bigint
  )
  where metric.store_id = p_store_id
    and metric.month = p_month
    and metric.product_id = incoming.product_id;

  update public.audit_store_month_metrics
  set source_range_start = nullif(p_store_metrics->>'source_range_start', '')::date,
      source_range_end = nullif(p_store_metrics->>'source_range_end', '')::date,
      cache_schema_version = greatest(
        coalesce((p_store_metrics->>'cache_schema_version')::integer, 0),
        0
      )
  where store_id = p_store_id and month = p_month;

  return v_count;
end;
$$;

create or replace function public.replace_audit_store_month_with_counts(
  p_store_id bigint,
  p_month date,
  p_product_metrics jsonb,
  p_store_metrics jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_products bigint := 0;
  v_old_store bigint := 0;
  v_old_unmatched bigint := 0;
  v_new_products bigint := 0;
  v_new_store bigint := 0;
  v_new_unmatched bigint := 0;
begin
  select count(*) into v_old_products
  from public.audit_product_month_metrics
  where store_id = p_store_id and month = p_month;

  select count(*) into v_old_store
  from public.audit_store_month_metrics
  where store_id = p_store_id and month = p_month;

  select count(*) into v_old_unmatched
  from public.audit_unmatched_landing_sessions
  where store_id = p_store_id and month = p_month;

  perform public.replace_audit_store_month_v2(
    p_store_id, p_month, p_product_metrics, p_store_metrics
  );

  select count(*) into v_new_products
  from public.audit_product_month_metrics
  where store_id = p_store_id and month = p_month;

  select count(*) into v_new_store
  from public.audit_store_month_metrics
  where store_id = p_store_id and month = p_month;

  select count(*) into v_new_unmatched
  from public.audit_unmatched_landing_sessions
  where store_id = p_store_id and month = p_month;

  return jsonb_build_object(
    'rows_processed', jsonb_array_length(p_product_metrics) + 1
      + jsonb_array_length(coalesce(p_store_metrics->'unmatched_landing_pages', '[]'::jsonb)),
    'rows_inserted', v_new_products + v_new_store + v_new_unmatched,
    'rows_updated', 0,
    'rows_deleted', v_old_products + v_old_store + v_old_unmatched
  );
end;
$$;

create or replace function public.get_audit_product_month_report(
  p_store_id bigint,
  p_start_month date,
  p_end_month date
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_products jsonb;
  v_product_metrics jsonb;
  v_store_metrics jsonb;
begin
  if p_store_id is null then raise exception 'store_id is required'; end if;
  if p_start_month is null or p_end_month is null then
    raise exception 'start and end month are required';
  end if;
  if p_start_month > p_end_month then raise exception 'invalid month range'; end if;
  if not exists (select 1 from public.audit_stores where id = p_store_id) then
    raise exception 'unknown store_id %', p_store_id;
  end if;

  select coalesce(jsonb_agg(item order by item->>'shopify_product_id'), '[]'::jsonb)
  into v_products
  from (
    select jsonb_build_object(
      'internal_product_id', product.id,
      'shopify_product_id', product.shopify_product_id,
      'record_kind', product.record_kind,
      'title', product.title,
      'handle', product.handle,
      'product_type', product.product_type,
      'status', case product.catalog_state
        when 'deleted' then 'DELETED'
        when 'missing' then 'MISSING'
        else upper(coalesce(nullif(product.status, ''), 'UNKNOWN'))
      end,
      'image_url', product.image_url,
      'shopify_created_at', product.shopify_created_at,
      'catalog_state', product.catalog_state,
      'tags', coalesce((
        select jsonb_agg(tag.tag order by tag.tag)
        from public.audit_product_tags tag
        where tag.product_id = product.id
      ), '[]'::jsonb)
    ) as item
    from public.audit_products product
    where product.store_id = p_store_id
  ) products;

  select coalesce(jsonb_agg(to_jsonb(metric) order by metric.month, metric.shopify_product_id), '[]'::jsonb)
  into v_product_metrics
  from (
    select
      monthly.month,
      product.shopify_product_id,
      product.record_kind,
      monthly.currency_code,
      monthly.first_day_in_inventory,
      monthly.starting_inventory,
      monthly.ending_inventory,
      monthly.landing_sessions,
      monthly.completed_checkout_sessions,
      monthly.product_orders,
      monthly.quantity_ordered,
      monthly.net_items_sold,
      monthly.reversed_quantity,
      monthly.gross_sales_minor,
      monthly.discounts_minor,
      monthly.sales_reversals_minor,
      monthly.net_sales_minor,
      monthly.shipping_charges_minor,
      monthly.return_fees_minor,
      monthly.taxes_minor,
      monthly.total_sales_minor,
      monthly.refreshed_at
    from public.audit_product_month_metrics monthly
    join public.audit_products product
      on product.id = monthly.product_id
     and product.store_id = monthly.store_id
    where monthly.store_id = p_store_id
      and monthly.month between p_start_month and p_end_month
  ) metric;

  select coalesce(jsonb_agg(to_jsonb(metric) order by metric.month), '[]'::jsonb)
  into v_store_metrics
  from (
    select
      month,
      currency_code,
      unique_orders,
      source_range_start,
      source_range_end,
      cache_schema_version,
      refreshed_at
    from public.audit_store_month_metrics
    where store_id = p_store_id
      and month between p_start_month and p_end_month
  ) metric;

  return jsonb_build_object(
    'products', v_products,
    'product_metrics', v_product_metrics,
    'store_metrics', v_store_metrics
  );
end;
$$;

revoke all on function public.replace_audit_store_month_v2(bigint, date, jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function public.get_audit_product_month_report(bigint, date, date)
  from public, anon, authenticated;
grant execute on function public.replace_audit_store_month_v2(bigint, date, jsonb, jsonb)
  to service_role;
grant execute on function public.get_audit_product_month_report(bigint, date, date)
  to service_role;

notify pgrst, 'reload schema';
