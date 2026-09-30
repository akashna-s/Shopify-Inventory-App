-- Preserve the currency meaning of every monthly money value. Cross-currency
-- replacement is rejected until an explicit conversion policy exists.

alter table public.audit_product_month_metrics
  add column if not exists currency_code varchar(3);
alter table public.audit_store_month_metrics
  add column if not exists currency_code varchar(3);

update public.audit_product_month_metrics metric
set currency_code = upper(store.currency_code)
from public.audit_stores store
where store.id = metric.store_id and metric.currency_code is null;

update public.audit_store_month_metrics metric
set currency_code = upper(store.currency_code)
from public.audit_stores store
where store.id = metric.store_id and metric.currency_code is null;

alter table public.audit_product_month_metrics
  alter column currency_code set not null;
alter table public.audit_store_month_metrics
  alter column currency_code set not null;

alter table public.audit_product_month_metrics
  drop constraint if exists audit_product_month_metrics_currency_check;
alter table public.audit_product_month_metrics
  add constraint audit_product_month_metrics_currency_check
    check (currency_code ~ '^[A-Z]{3}$');

alter table public.audit_store_month_metrics
  drop constraint if exists audit_store_month_metrics_currency_check;
alter table public.audit_store_month_metrics
  add constraint audit_store_month_metrics_currency_check
    check (currency_code ~ '^[A-Z]{3}$');

comment on column public.audit_product_month_metrics.currency_code is
  'ISO-style three-letter currency applying to this product-month money data. Never sum across codes without conversion.';
comment on column public.audit_store_month_metrics.currency_code is
  'ISO-style three-letter currency applying to this store-month. Never sum across codes without conversion.';

create index if not exists audit_store_month_metrics_currency_idx
  on public.audit_store_month_metrics(currency_code, month);

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
  v_existing_snapshots jsonb;
  v_existing_store_currency varchar(3);
  v_incoming_currency varchar(3);
begin
  if p_store_id is null then raise exception 'store_id is required'; end if;
  if p_month is null then raise exception 'month is required'; end if;
  if jsonb_typeof(coalesce(p_product_metrics, 'null'::jsonb)) <> 'array' then
    raise exception 'product metrics must be a JSON array';
  end if;
  if jsonb_typeof(coalesce(p_store_metrics, 'null'::jsonb)) <> 'object' then
    raise exception 'store metrics must be a JSON object';
  end if;
  if not exists (select 1 from public.audit_stores where id = p_store_id) then
    raise exception 'unknown store_id %', p_store_id;
  end if;

  v_incoming_currency := upper(trim(coalesce(p_store_metrics->>'currency_code', '')));
  if v_incoming_currency !~ '^[A-Z]{3}$' then
    raise exception 'a valid three-letter currency_code is required';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_product_metrics) as metric(product_id bigint, currency_code text)
    left join public.audit_products product
      on product.id = metric.product_id and product.store_id = p_store_id
    where metric.product_id is null
       or product.id is null
       or upper(trim(coalesce(metric.currency_code, ''))) <> v_incoming_currency
  ) then
    raise exception 'products must belong to store_id % and use currency %',
      p_store_id, v_incoming_currency;
  end if;

  select currency_code into v_existing_store_currency
  from public.audit_store_month_metrics
  where store_id = p_store_id and month = p_month;
  if v_existing_store_currency is not null
     and v_existing_store_currency <> v_incoming_currency then
    raise exception 'cannot replace existing % month % with currency % without conversion',
      v_existing_store_currency, p_month, v_incoming_currency;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'product_id', product_id,
    'currency_code', currency_code,
    'title_snapshot', title_snapshot,
    'product_type_snapshot', product_type_snapshot,
    'handle_snapshot', handle_snapshot
  )), '[]'::jsonb)
  into v_existing_snapshots
  from public.audit_product_month_metrics
  where store_id = p_store_id and month = p_month;

  delete from public.audit_product_month_metrics
  where store_id = p_store_id and month = p_month;
  delete from public.audit_store_month_metrics
  where store_id = p_store_id and month = p_month;
  delete from public.audit_unmatched_landing_sessions
  where store_id = p_store_id and month = p_month;

  insert into public.audit_product_month_metrics (
    store_id, product_id, month, currency_code,
    title_snapshot, product_type_snapshot, handle_snapshot,
    first_day_in_inventory, starting_inventory, ending_inventory,
    landing_sessions, product_orders, quantity_ordered, net_items_sold,
    reversed_quantity, gross_sales_minor, discounts_minor,
    sales_reversals_minor, net_sales_minor, shipping_charges_minor,
    return_fees_minor, taxes_minor, total_sales_minor, refreshed_at
  )
  select
    p_store_id, metric.product_id, p_month,
    coalesce(existing.currency_code, v_incoming_currency),
    coalesce(existing.title_snapshot, metric.title_snapshot, product.title, ''),
    coalesce(existing.product_type_snapshot, metric.product_type_snapshot, product.product_type, ''),
    coalesce(existing.handle_snapshot, metric.handle_snapshot, product.handle, ''),
    metric.first_day_in_inventory, metric.starting_inventory,
    metric.ending_inventory, coalesce(metric.landing_sessions, 0),
    coalesce(metric.product_orders, metric.orders, 0),
    coalesce(metric.quantity_ordered, 0), coalesce(metric.net_items_sold, 0),
    coalesce(metric.reversed_quantity, 0), coalesce(metric.gross_sales_minor, 0),
    coalesce(metric.discounts_minor, 0), coalesce(metric.sales_reversals_minor, 0),
    coalesce(metric.net_sales_minor, 0), coalesce(metric.shipping_charges_minor, 0),
    coalesce(metric.return_fees_minor, 0), coalesce(metric.taxes_minor, 0),
    coalesce(metric.total_sales_minor, 0), coalesce(metric.refreshed_at, now())
  from jsonb_to_recordset(p_product_metrics) as metric(
    product_id bigint, currency_code text,
    title_snapshot text, product_type_snapshot text, handle_snapshot text,
    first_day_in_inventory date, starting_inventory integer, ending_inventory integer,
    landing_sessions bigint, product_orders bigint, orders bigint,
    quantity_ordered bigint, net_items_sold bigint, reversed_quantity bigint,
    gross_sales_minor bigint, discounts_minor bigint, sales_reversals_minor bigint,
    net_sales_minor bigint, shipping_charges_minor bigint, return_fees_minor bigint,
    taxes_minor bigint, total_sales_minor bigint, refreshed_at timestamptz
  )
  join public.audit_products product
    on product.id = metric.product_id and product.store_id = p_store_id
  left join jsonb_to_recordset(v_existing_snapshots) as existing(
    product_id bigint, currency_code varchar(3),
    title_snapshot text, product_type_snapshot text, handle_snapshot text
  ) on existing.product_id = metric.product_id;
  get diagnostics v_product_count = row_count;

  insert into public.audit_store_month_metrics (
    store_id, month, currency_code, active_products,
    starting_inventory, ending_inventory, unique_orders, landing_sessions,
    matched_product_landing_sessions, unmatched_product_landing_sessions,
    store_sessions, total_sales_minor, refreshed_at
  )
  select
    p_store_id, p_month,
    coalesce(v_existing_store_currency, v_incoming_currency),
    coalesce(metric.active_products, 0),
    greatest(coalesce(metric.starting_inventory, 0), 0),
    greatest(coalesce(metric.ending_inventory, 0), 0),
    coalesce(metric.unique_orders, 0), coalesce(metric.landing_sessions, 0),
    coalesce(metric.matched_product_landing_sessions, metric.landing_sessions, 0),
    coalesce(metric.unmatched_product_landing_sessions, 0),
    coalesce(metric.store_sessions, 0), coalesce(metric.total_sales_minor, 0),
    coalesce(metric.refreshed_at, now())
  from jsonb_to_record(p_store_metrics) as metric(
    active_products integer, starting_inventory bigint, ending_inventory bigint,
    unique_orders bigint, landing_sessions bigint,
    matched_product_landing_sessions bigint,
    unmatched_product_landing_sessions bigint, store_sessions bigint,
    total_sales_minor bigint, refreshed_at timestamptz
  );

  insert into public.audit_unmatched_landing_sessions(
    store_id, month, handle, sessions, refreshed_at
  )
  select p_store_id, p_month, lower(trim(item.handle)),
    coalesce(item.sessions, 0), now()
  from jsonb_to_recordset(
    coalesce(p_store_metrics->'unmatched_landing_pages', '[]'::jsonb)
  ) as item(handle text, sessions bigint)
  where trim(coalesce(item.handle, '')) <> ''
    and coalesce(item.sessions, 0) > 0;

  return v_product_count + 1;
end;
$$;

revoke all on function public.replace_audit_store_month(bigint, date, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.replace_audit_store_month(bigint, date, jsonb, jsonb)
  to service_role;
