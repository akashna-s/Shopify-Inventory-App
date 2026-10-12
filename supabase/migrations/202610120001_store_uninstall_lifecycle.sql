create or replace function public.mark_audit_store_uninstalled(
  p_shop_domain text
)
returns public.audit_stores
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store public.audit_stores%rowtype;
  v_shop_domain text := lower(trim(coalesce(p_shop_domain, '')));
begin
  if v_shop_domain = '' then
    raise exception 'A shop domain is required.';
  end if;

  update public.audit_stores store
  set status = 'uninstalled',
      uninstalled_at = now(),
      updated_at = now()
  where store.shop_domain = v_shop_domain
  returning * into v_store;

  return v_store;
end;
$$;

revoke all on function public.mark_audit_store_uninstalled(text)
  from public, anon, authenticated;
grant execute on function public.mark_audit_store_uninstalled(text)
  to service_role;

comment on function public.mark_audit_store_uninstalled(text) is
  'Marks an uninstalled Shopify store inactive without deleting its retained analytics history.';
