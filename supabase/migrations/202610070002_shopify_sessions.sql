-- Persistent Shopify sessions for stateless hosts such as Render Free.
-- The browser roles receive no access; only the server-side service role can
-- read the Shopify access tokens required for authenticated and scheduled work.

create table if not exists public.audit_shopify_sessions (
  id text primary key,
  shop text not null,
  state text not null,
  is_online boolean not null default false,
  scope text,
  expires timestamptz,
  access_token text not null,
  user_id text,
  first_name text,
  last_name text,
  email text,
  account_owner boolean not null default false,
  locale text,
  collaborator boolean not null default false,
  email_verified boolean not null default false,
  refresh_token text,
  refresh_token_expires timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists audit_shopify_sessions_shop_idx
  on public.audit_shopify_sessions(shop);
create index if not exists audit_shopify_sessions_expires_idx
  on public.audit_shopify_sessions(expires desc);

alter table public.audit_shopify_sessions enable row level security;
revoke all on table public.audit_shopify_sessions from public, anon, authenticated;
grant select, insert, update, delete on table public.audit_shopify_sessions to service_role;

comment on table public.audit_shopify_sessions is
  'Server-only Shopify online and offline sessions. Keeps authentication available when stateless app hosts restart.';

notify pgrst, 'reload schema';
