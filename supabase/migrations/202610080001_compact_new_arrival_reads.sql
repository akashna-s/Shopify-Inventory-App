create or replace function public.get_audit_new_arrival_month_report(
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
      'shopify_product_id', product.shopify_product_id,
      'record_kind', product.record_kind,
      'title', product.title,
      'handle', product.handle,
      'product_type', product.product_type,
      'image_url', product.image_url,
      'tags', coalesce((
        select jsonb_agg(tag.tag order by tag.tag)
        from public.audit_product_tags tag
        where tag.product_id = product.id
      ), '[]'::jsonb)
    ) as item
    from public.audit_products product
    join (
      select distinct monthly.product_id
      from public.audit_product_month_metrics monthly
      where monthly.store_id = p_store_id
        and monthly.month between p_start_month and p_end_month
    ) selected_product on selected_product.product_id = product.id
    where product.store_id = p_store_id
  ) products;

  select coalesce(
    jsonb_agg(to_jsonb(metric) order by metric.month, metric.shopify_product_id),
    '[]'::jsonb
  )
  into v_product_metrics
  from (
    select
      monthly.month,
      product.shopify_product_id,
      monthly.starting_inventory,
      monthly.ending_inventory,
      monthly.landing_sessions,
      monthly.product_orders,
      monthly.total_sales_minor
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
      total_sales_minor,
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

revoke all on function public.get_audit_new_arrival_month_report(bigint, date, date)
  from public, anon, authenticated;
grant execute on function public.get_audit_new_arrival_month_report(bigint, date, date)
  to service_role;

notify pgrst, 'reload schema';
