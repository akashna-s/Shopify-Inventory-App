-- Private object storage for stores assigned to file_cache mode. Browsers never
-- receive the service-role key and never read this bucket directly; all reads
-- pass through an authenticated Shopify app route that derives the store ID
-- from the Shopify session.

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'analytics-monthly-cache',
  'analytics-monthly-cache',
  false,
  26214400,
  array['application/gzip', 'application/json']::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

comment on column public.audit_stores.storage_mode is
  'Fixed analytics storage assignment: database uses PostgreSQL facts; file_cache uses private compressed objects plus browser IndexedDB.';
