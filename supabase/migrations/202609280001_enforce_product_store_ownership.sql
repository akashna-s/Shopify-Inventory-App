-- Ensure every product-month metric belongs to the same store as its product.
--
-- Conceptually, this enforces:
--   metric.product_id = product.id
--   AND metric.store_id = product.store_id
--
-- The existing individual foreign keys remain useful for their direct
-- relationships and cascade behavior. This composite key adds the missing
-- ownership check between the two columns.

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'audit_products_id_store_id_key'
      and conrelid = 'public.audit_products'::regclass
  ) then
    alter table public.audit_products
      add constraint audit_products_id_store_id_key
      unique (id, store_id);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'audit_product_month_metrics_product_store_fkey'
      and conrelid = 'public.audit_product_month_metrics'::regclass
  ) then
    alter table public.audit_product_month_metrics
      add constraint audit_product_month_metrics_product_store_fkey
      foreign key (product_id, store_id)
      references public.audit_products (id, store_id)
      on delete cascade
      not valid;
  end if;
end
$$;

-- Validation checks all existing rows. The migration stops here if any old
-- row contains a product/store mismatch, rather than silently accepting it.
alter table public.audit_product_month_metrics
  validate constraint audit_product_month_metrics_product_store_fkey;
