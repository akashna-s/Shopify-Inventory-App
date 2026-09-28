-- Replace one store-month as a single PostgreSQL transaction.
-- A function call either replaces the complete month or leaves the previous
-- stored month unchanged when any validation or insert fails.

create or replace function public.replace_audit_store_month(
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
  v_product_count integer;
begin
  if p_store_id is null or not exists (
    select 1 from public.audit_stores where id = p_store_id
  ) then
    raise exception 'A valid audit store is required.';
  end if;

  if p_month is null or p_month <> date_trunc('month', p_month)::date then
    raise exception 'The replacement month must be the first day of a month.';
  end if;

  if p_product_metrics is null or jsonb_typeof(p_product_metrics) <> 'array' then
    raise exception 'Product metrics must be a JSON array.';
  end if;

  if p_store_metrics is null or jsonb_typeof(p_store_metrics) <> 'object' then
    raise exception 'Store metrics must be a JSON object.';
  end if;

  -- Validate ownership before deleting the previously stored month.
  if exists (
    select 1
    from jsonb_to_recordset(p_product_metrics) as metric(product_id bigint)
    left join public.audit_products product
      on product.id = metric.product_id
     and product.store_id = p_store_id
    where metric.product_id is null or product.id is null
  ) then
    raise exception 'Every product metric must belong to the selected store.';
  end if;

  delete from public.audit_product_month_metrics
  where store_id = p_store_id and month = p_month;

  delete from public.audit_store_month_metrics
  where store_id = p_store_id and month = p_month;

  insert into public.audit_product_month_metrics (
    store_id,
    product_id,
    month,
    first_day_in_inventory,
    starting_inventory,
    ending_inventory,
    landing_sessions,
    orders,
    quantity_ordered,
    net_items_sold,
    reversed_quantity,
    gross_sales_minor,
    discounts_minor,
    sales_reversals_minor,
    net_sales_minor,
    shipping_charges_minor,
    return_fees_minor,
    taxes_minor,
    total_sales_minor,
    refreshed_at
  )
  select
    p_store_id,
    metric.product_id,
    p_month,
    metric.first_day_in_inventory,
    metric.starting_inventory,
    metric.ending_inventory,
    coalesce(metric.landing_sessions, 0),
    coalesce(metric.orders, 0),
    coalesce(metric.quantity_ordered, 0),
    coalesce(metric.net_items_sold, 0),
    coalesce(metric.reversed_quantity, 0),
    coalesce(metric.gross_sales_minor, 0),
    coalesce(metric.discounts_minor, 0),
    coalesce(metric.sales_reversals_minor, 0),
    coalesce(metric.net_sales_minor, 0),
    coalesce(metric.shipping_charges_minor, 0),
    coalesce(metric.return_fees_minor, 0),
    coalesce(metric.taxes_minor, 0),
    coalesce(metric.total_sales_minor, 0),
    coalesce(metric.refreshed_at, now())
  from jsonb_to_recordset(p_product_metrics) as metric(
    product_id bigint,
    first_day_in_inventory date,
    starting_inventory integer,
    ending_inventory integer,
    landing_sessions bigint,
    orders bigint,
    quantity_ordered bigint,
    net_items_sold bigint,
    reversed_quantity bigint,
    gross_sales_minor bigint,
    discounts_minor bigint,
    sales_reversals_minor bigint,
    net_sales_minor bigint,
    shipping_charges_minor bigint,
    return_fees_minor bigint,
    taxes_minor bigint,
    total_sales_minor bigint,
    refreshed_at timestamptz
  );

  get diagnostics v_product_count = row_count;

  insert into public.audit_store_month_metrics (
    store_id,
    month,
    active_products,
    starting_inventory,
    ending_inventory,
    unique_orders,
    landing_sessions,
    total_sales_minor,
    refreshed_at
  )
  select
    p_store_id,
    p_month,
    coalesce(metric.active_products, 0),
    metric.starting_inventory,
    metric.ending_inventory,
    coalesce(metric.unique_orders, 0),
    coalesce(metric.landing_sessions, 0),
    coalesce(metric.total_sales_minor, 0),
    coalesce(metric.refreshed_at, now())
  from jsonb_to_record(p_store_metrics) as metric(
    active_products integer,
    starting_inventory bigint,
    ending_inventory bigint,
    unique_orders bigint,
    landing_sessions bigint,
    total_sales_minor bigint,
    refreshed_at timestamptz
  );

  return v_product_count + 1;
end;
$$;

revoke all on function public.replace_audit_store_month(bigint, date, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.replace_audit_store_month(bigint, date, jsonb, jsonb)
  to service_role;
