-- Upgrade an existing, previously validated store-month to cache schema v1
-- without replacing its inventory, sales, order, or currency facts. Only the
-- handle-based session fields introduced by v1 are refreshed.

create or replace function public.upgrade_audit_store_month_sessions_v1(
  p_store_id bigint,
  p_month date,
  p_range_start date,
  p_range_end date,
  p_product_sessions jsonb,
  p_unmatched_landing_pages jsonb,
  p_store_sessions bigint,
  p_refreshed_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_matched_sessions bigint := 0;
  v_unmatched_sessions bigint := 0;
  v_product_updates bigint := 0;
  v_unmatched_rows bigint := 0;
  v_deleted_unmatched_rows bigint := 0;
begin
  if p_store_id is null then raise exception 'store_id is required'; end if;
  if p_month is null or date_trunc('month', p_month)::date <> p_month then
    raise exception 'a first-of-month date is required';
  end if;
  if p_range_start is null or p_range_end is null
     or p_range_start > p_range_end
     or date_trunc('month', p_range_start)::date <> p_month
     or date_trunc('month', p_range_end)::date <> p_month then
    raise exception 'the source range must stay inside the selected month';
  end if;
  if not exists (
    select 1 from public.audit_store_month_metrics
    where store_id = p_store_id and month = p_month
  ) then
    raise exception 'the legacy store-month does not exist';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(coalesce(p_product_sessions, '[]'::jsonb)) as item(
      product_id bigint,
      landing_sessions bigint,
      completed_checkout_sessions bigint
    )
    left join public.audit_products product
      on product.id = item.product_id and product.store_id = p_store_id
    where product.id is null
  ) then
    raise exception 'a session row does not belong to the selected store';
  end if;

  update public.audit_product_month_metrics
  set landing_sessions = 0,
      completed_checkout_sessions = 0,
      refreshed_at = coalesce(p_refreshed_at, now())
  where store_id = p_store_id and month = p_month;

  update public.audit_product_month_metrics metric
  set landing_sessions = greatest(coalesce(item.landing_sessions, 0), 0),
      completed_checkout_sessions = greatest(
        coalesce(item.completed_checkout_sessions, 0),
        0
      ),
      refreshed_at = coalesce(p_refreshed_at, now())
  from jsonb_to_recordset(coalesce(p_product_sessions, '[]'::jsonb)) as item(
    product_id bigint,
    landing_sessions bigint,
    completed_checkout_sessions bigint
  )
  where metric.store_id = p_store_id
    and metric.month = p_month
    and metric.product_id = item.product_id;
  get diagnostics v_product_updates = row_count;

  select coalesce(sum(greatest(coalesce(item.landing_sessions, 0), 0)), 0)
  into v_matched_sessions
  from jsonb_to_recordset(coalesce(p_product_sessions, '[]'::jsonb)) as item(
    product_id bigint,
    landing_sessions bigint,
    completed_checkout_sessions bigint
  );

  delete from public.audit_unmatched_landing_sessions
  where store_id = p_store_id and month = p_month;
  get diagnostics v_deleted_unmatched_rows = row_count;

  insert into public.audit_unmatched_landing_sessions(
    store_id,
    month,
    handle,
    sessions,
    refreshed_at
  )
  select
    p_store_id,
    p_month,
    nullif(trim(item.handle), ''),
    greatest(coalesce(item.sessions, 0), 0),
    coalesce(p_refreshed_at, now())
  from jsonb_to_recordset(coalesce(p_unmatched_landing_pages, '[]'::jsonb)) as item(
    handle text,
    sessions bigint
  )
  where nullif(trim(item.handle), '') is not null
    and greatest(coalesce(item.sessions, 0), 0) > 0;
  get diagnostics v_unmatched_rows = row_count;

  select coalesce(sum(greatest(coalesce(item.sessions, 0), 0)), 0)
  into v_unmatched_sessions
  from jsonb_to_recordset(coalesce(p_unmatched_landing_pages, '[]'::jsonb)) as item(
    handle text,
    sessions bigint
  );

  update public.audit_store_month_metrics
  set landing_sessions = v_matched_sessions,
      matched_product_landing_sessions = v_matched_sessions,
      unmatched_product_landing_sessions = v_unmatched_sessions,
      store_sessions = greatest(coalesce(p_store_sessions, 0), 0),
      source_range_start = p_range_start,
      source_range_end = p_range_end,
      cache_schema_version = 1,
      refreshed_at = coalesce(p_refreshed_at, now())
  where store_id = p_store_id and month = p_month;

  return jsonb_build_object(
    'rows_processed', jsonb_array_length(coalesce(p_product_sessions, '[]'::jsonb))
      + jsonb_array_length(coalesce(p_unmatched_landing_pages, '[]'::jsonb)) + 1,
    'rows_inserted', v_unmatched_rows,
    'rows_updated', v_product_updates + 1,
    'rows_deleted', v_deleted_unmatched_rows
  );
end;
$$;

revoke all on function public.upgrade_audit_store_month_sessions_v1(
  bigint, date, date, date, jsonb, jsonb, bigint, timestamptz
) from public, anon, authenticated;
grant execute on function public.upgrade_audit_store_month_sessions_v1(
  bigint, date, date, date, jsonb, jsonb, bigint, timestamptz
) to service_role;

notify pgrst, 'reload schema';
