-- Replace each refreshed product's complete tag set in one transaction.
-- PostgreSQL automatically rolls back every delete if validation or insertion fails.

create or replace function public.replace_audit_product_tags(
  p_store_id bigint,
  p_refreshed_product_ids bigint[],
  p_tags jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted integer := 0;
begin
  if p_store_id is null then raise exception 'store_id is required'; end if;
  if p_refreshed_product_ids is null then
    raise exception 'refreshed product IDs are required';
  end if;
  if jsonb_typeof(coalesce(p_tags, 'null'::jsonb)) <> 'array' then
    raise exception 'tags must be a JSON array';
  end if;
  if not exists (select 1 from public.audit_stores where id = p_store_id) then
    raise exception 'unknown store_id %', p_store_id;
  end if;

  if exists (
    select 1
    from unnest(p_refreshed_product_ids) refreshed(product_id)
    left join public.audit_products product
      on product.id = refreshed.product_id
     and product.store_id = p_store_id
    where refreshed.product_id is null or product.id is null
  ) then
    raise exception 'one or more refreshed products do not belong to store_id %', p_store_id;
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_tags) as incoming(product_id bigint, tag text)
    left join public.audit_products product
      on product.id = incoming.product_id
     and product.store_id = p_store_id
    where incoming.product_id is null
       or product.id is null
       or not (incoming.product_id = any(p_refreshed_product_ids))
       or trim(coalesce(incoming.tag, '')) = ''
  ) then
    raise exception 'every tag must be non-empty and belong to a refreshed product in store_id %', p_store_id;
  end if;

  delete from public.audit_product_tags
  where product_id = any(p_refreshed_product_ids);

  insert into public.audit_product_tags(product_id, tag)
  select distinct incoming.product_id, trim(incoming.tag)
  from jsonb_to_recordset(p_tags) as incoming(product_id bigint, tag text);
  get diagnostics v_inserted = row_count;

  return v_inserted;
end;
$$;

revoke all on function public.replace_audit_product_tags(bigint, bigint[], jsonb)
  from public, anon, authenticated;
grant execute on function public.replace_audit_product_tags(bigint, bigint[], jsonb)
  to service_role;

comment on function public.replace_audit_product_tags(bigint, bigint[], jsonb) is
  'Atomically validates and replaces tags for one authenticated store catalogue refresh.';
