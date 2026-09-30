-- Store each Shopify shop's canonical timezone for calendar-safe report ranges.

alter table public.audit_stores
  add column if not exists iana_timezone text not null default 'Etc/UTC';

alter table public.audit_stores
  drop constraint if exists audit_stores_iana_timezone_not_blank;
alter table public.audit_stores
  add constraint audit_stores_iana_timezone_not_blank
    check (trim(iana_timezone) <> '');

comment on column public.audit_stores.iana_timezone is
  'Shopify shop IANA timezone, for example Asia/Kolkata or America/New_York. Date boundaries must use this value rather than the app server timezone.';
