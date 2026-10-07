import { Session } from "@shopify/shopify-api";

function configuration() {
  const url = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
  if (!url || !serviceRoleKey) {
    throw new Error("Supabase session storage is not configured.");
  }
  return { url, serviceRoleKey };
}

async function request(path, options = {}) {
  const { url, serviceRoleKey } = configuration();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!response.ok) {
    throw new Error(
      `Supabase session request failed (${response.status}): ${await response.text()}`,
    );
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function isoDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function sessionRow(session) {
  const values = session.toObject();
  const user = values.onlineAccessInfo?.associated_user;
  return {
    id: session.id,
    shop: session.shop,
    state: session.state,
    is_online: Boolean(session.isOnline),
    scope: session.scope || null,
    expires: isoDate(session.expires),
    access_token: session.accessToken || "",
    user_id: user?.id == null ? null : String(user.id),
    first_name: user?.first_name || null,
    last_name: user?.last_name || null,
    email: user?.email || null,
    account_owner: Boolean(user?.account_owner),
    locale: user?.locale || null,
    collaborator: Boolean(user?.collaborator),
    email_verified: Boolean(user?.email_verified),
    refresh_token: values.refreshToken || null,
    refresh_token_expires: isoDate(values.refreshTokenExpires),
    updated_at: new Date().toISOString(),
  };
}

function rowSession(row) {
  const values = {
    id: row.id,
    shop: row.shop,
    state: row.state,
    isOnline: Boolean(row.is_online),
  };
  if (row.scope) values.scope = row.scope;
  if (row.expires) values.expires = new Date(row.expires).getTime();
  if (row.access_token) values.accessToken = row.access_token;
  if (row.user_id != null) values.userId = String(row.user_id);
  if (row.first_name != null) values.firstName = String(row.first_name);
  if (row.last_name != null) values.lastName = String(row.last_name);
  if (row.email != null) values.email = String(row.email);
  if (row.locale != null) values.locale = String(row.locale);
  if (row.account_owner != null) values.accountOwner = row.account_owner;
  if (row.collaborator != null) values.collaborator = row.collaborator;
  if (row.email_verified != null) values.emailVerified = row.email_verified;
  if (row.refresh_token) values.refreshToken = row.refresh_token;
  if (row.refresh_token_expires) {
    values.refreshTokenExpires = new Date(row.refresh_token_expires).getTime();
  }
  return Session.fromPropertyArray(Object.entries(values), true);
}

export class SupabaseSessionStorage {
  constructor({ fallback = null } = {}) {
    this.fallback = fallback;
  }

  async storeSession(session) {
    await request("audit_shopify_sessions?on_conflict=id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(sessionRow(session)),
    });
    return true;
  }

  async loadSession(id) {
    const rows = await request(
      `audit_shopify_sessions?select=*&id=eq.${encodeURIComponent(id)}&limit=1`,
    );
    if (rows?.[0]) return rowSession(rows[0]);
    const legacy = await this.fallback?.loadSession(id);
    if (legacy) await this.storeSession(legacy);
    return legacy;
  }

  async deleteSession(id) {
    await request(`audit_shopify_sessions?id=eq.${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Prefer: "return=minimal" },
    });
    await this.fallback?.deleteSession(id);
    return true;
  }

  async deleteSessions(ids) {
    await Promise.all(ids.map((id) => this.deleteSession(id)));
    return true;
  }

  async findSessionsByShop(shop) {
    const rows = await request(
      `audit_shopify_sessions?select=*&shop=eq.${encodeURIComponent(shop)}` +
        "&order=expires.desc.nullslast&limit=25",
    );
    if (rows?.length) return rows.map(rowSession);
    const legacy = (await this.fallback?.findSessionsByShop(shop)) || [];
    await Promise.all(legacy.map((session) => this.storeSession(session)));
    return legacy;
  }

  async isReady() {
    try {
      await request("audit_shopify_sessions?select=id&limit=1");
      return true;
    } catch {
      return false;
    }
  }
}
