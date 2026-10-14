-- Permanently remove an uninstalled store after its retention window.
-- Deleting audit_stores cascades through all store-scoped analytics tables.

create or replace function public.purge_audit_store_if_expired(
  p_store_id bigint,
  p_retention_days integer default 15
)
returns table (
  store_id bigint,
  shop_domain text,
  storage_mode text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store public.audit_stores%rowtype;
begin
  if p_store_id is null then
    raise exception 'A store ID is required.';
  end if;
  if p_retention_days < 1 then
    raise exception 'Retention days must be at least 1.';
  end if;

  select *
  into v_store
  from public.audit_stores store
  where store.id = p_store_id
    and store.status = 'uninstalled'
    and store.uninstalled_at is not null
    and store.uninstalled_at <= now() - make_interval(days => p_retention_days)
  for update;

  if not found then
    return;
  end if;

  -- Sessions normally disappear in the uninstall webhook. This is a final
  -- safeguard for a partially completed uninstall.
  delete from public.audit_shopify_sessions session
  where lower(session.shop) = lower(v_store.shop_domain);

  delete from public.audit_stores store
  where store.id = v_store.id;

  return query select v_store.id, v_store.shop_domain, v_store.storage_mode;
end;
$$;

revoke all on function public.purge_audit_store_if_expired(bigint, integer)
  from public, anon, authenticated;
grant execute on function public.purge_audit_store_if_expired(bigint, integer)
  to service_role;

comment on function public.purge_audit_store_if_expired(bigint, integer) is
  'Permanently deletes an uninstalled store and its cascaded analytics after the configured retention period.';

notify pgrst, 'reload schema';
