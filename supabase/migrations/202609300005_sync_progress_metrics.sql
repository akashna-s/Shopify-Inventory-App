-- Make sync operations observable without overloading the legacy attempts and
-- rows_written fields with several different meanings.

alter table public.audit_sync_jobs
  add column if not exists job_attempt integer not null default 1,
  add column if not exists query_retry_count integer not null default 0,
  add column if not exists rows_processed bigint not null default 0,
  add column if not exists rows_inserted bigint not null default 0,
  add column if not exists rows_updated bigint not null default 0,
  add column if not exists rows_deleted bigint not null default 0,
  add column if not exists error_summary text;

update public.audit_sync_jobs
set
  job_attempt = greatest(coalesce(attempts, 1), 1),
  rows_processed = greatest(coalesce(rows_written, 0), 0),
  error_summary = left(regexp_replace(coalesce(error_message, ''), '\s+', ' ', 'g'), 500)
where job_attempt = 1
  and query_retry_count = 0
  and rows_processed = 0
  and rows_inserted = 0
  and rows_updated = 0
  and rows_deleted = 0;

alter table public.audit_sync_jobs
  drop constraint if exists audit_sync_jobs_progress_nonnegative_check;
alter table public.audit_sync_jobs
  add constraint audit_sync_jobs_progress_nonnegative_check check (
    job_attempt >= 1
    and query_retry_count >= 0
    and rows_processed >= 0
    and rows_inserted >= 0
    and rows_updated >= 0
    and rows_deleted >= 0
  );

comment on column public.audit_sync_jobs.job_attempt is
  'Attempt number for the complete sync job. This is separate from retries of individual ShopifyQL queries.';
comment on column public.audit_sync_jobs.query_retry_count is
  'Number of ShopifyQL query executions beyond their first execution during this job.';
comment on column public.audit_sync_jobs.rows_processed is
  'Incoming primary report rows processed: catalog products, tags, product-month rows, store-month rows and unmatched landing rows.';
comment on column public.audit_sync_jobs.rows_inserted is
  'Primary report rows actually inserted, including rows inserted during atomic replacement.';
comment on column public.audit_sync_jobs.rows_updated is
  'Primary report rows actually updated by catalog upsert.';
comment on column public.audit_sync_jobs.rows_deleted is
  'Primary report rows actually deleted during replacement or retention cleanup.';
comment on column public.audit_sync_jobs.error_summary is
  'Short human-readable error summary for operational monitoring.';
comment on column public.audit_sync_jobs.attempts is
  'Legacy compatibility field. New jobs mirror job_attempt here.';
comment on column public.audit_sync_jobs.rows_written is
  'Legacy compatibility field. New jobs store rows_inserted plus rows_updated here.';

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

  perform public.replace_audit_store_month(
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

create or replace function public.replace_audit_product_tags_with_counts(
  p_store_id bigint,
  p_refreshed_product_ids bigint[],
  p_tags jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_tags bigint := 0;
  v_new_tags bigint := 0;
begin
  select count(*) into v_old_tags
  from public.audit_product_tags
  where product_id = any(p_refreshed_product_ids);

  v_new_tags := public.replace_audit_product_tags(
    p_store_id, p_refreshed_product_ids, p_tags
  );

  return jsonb_build_object(
    'rows_processed', jsonb_array_length(p_tags),
    'rows_inserted', v_new_tags,
    'rows_updated', 0,
    'rows_deleted', v_old_tags
  );
end;
$$;

create or replace function public.delete_expired_audit_monthly_metrics_with_counts(
  p_store_id bigint,
  p_retain_from_month date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_products bigint := 0;
  v_store bigint := 0;
  v_unmatched bigint := 0;
begin
  if p_store_id is null then raise exception 'store_id is required'; end if;
  if p_retain_from_month is null then raise exception 'retention month is required'; end if;
  if not exists (select 1 from public.audit_stores where id = p_store_id) then
    raise exception 'unknown store_id %', p_store_id;
  end if;

  delete from public.audit_product_month_metrics
  where store_id = p_store_id and month < p_retain_from_month;
  get diagnostics v_products = row_count;

  delete from public.audit_store_month_metrics
  where store_id = p_store_id and month < p_retain_from_month;
  get diagnostics v_store = row_count;

  delete from public.audit_unmatched_landing_sessions
  where store_id = p_store_id and month < p_retain_from_month;
  get diagnostics v_unmatched = row_count;

  return jsonb_build_object(
    'rows_processed', 0,
    'rows_inserted', 0,
    'rows_updated', 0,
    'rows_deleted', v_products + v_store + v_unmatched
  );
end;
$$;

revoke all on function public.replace_audit_store_month_with_counts(bigint, date, jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function public.replace_audit_product_tags_with_counts(bigint, bigint[], jsonb)
  from public, anon, authenticated;
revoke all on function public.delete_expired_audit_monthly_metrics_with_counts(bigint, date)
  from public, anon, authenticated;
grant execute on function public.replace_audit_store_month_with_counts(bigint, date, jsonb, jsonb)
  to service_role;
grant execute on function public.replace_audit_product_tags_with_counts(bigint, bigint[], jsonb)
  to service_role;
grant execute on function public.delete_expired_audit_monthly_metrics_with_counts(bigint, date)
  to service_role;

comment on function public.replace_audit_store_month_with_counts(bigint, date, jsonb, jsonb) is
  'Atomically replaces one store-month and returns separate processed, inserted, updated and deleted row counts.';
comment on function public.replace_audit_product_tags_with_counts(bigint, bigint[], jsonb) is
  'Atomically replaces refreshed product tags and returns separate write counts.';
comment on function public.delete_expired_audit_monthly_metrics_with_counts(bigint, date) is
  'Deletes expired monthly report rows for one store and returns the actual deletion count.';
