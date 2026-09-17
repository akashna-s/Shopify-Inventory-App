const BATCH_SIZE = 500;

function config() {
  const url = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!url || !serviceRoleKey) {
    throw new Error(
      "Supabase analytics is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the server.",
    );
  }
  return { url, serviceRoleKey };
}

async function request(path, options = {}) {
  const { url, serviceRoleKey } = config();
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
    const message = await response.text();
    throw new Error(`Supabase analytics request failed (${response.status}): ${message}`);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function queryValue(value) {
  return encodeURIComponent(String(value));
}

function chunks(rows, size = BATCH_SIZE) {
  const output = [];
  for (let index = 0; index < rows.length; index += size) {
    output.push(rows.slice(index, index + size));
  }
  return output;
}

export function isSupabaseAnalyticsConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export async function testSupabaseAnalyticsConnection() {
  return request("audit_stores?select=id&limit=1");
}

export async function selectSupabaseRows(table, {
  select = "*",
  filters = [],
  order = "",
  limit = 0,
} = {}) {
  const params = [`select=${encodeURIComponent(select)}`];
  for (const [column, operator, value] of filters) {
    params.push(`${encodeURIComponent(column)}=${operator}.${queryValue(value)}`);
  }
  if (order) params.push(`order=${encodeURIComponent(order)}`);
  if (limit > 0) params.push(`limit=${limit}`);
  return request(`${table}?${params.join("&")}`);
}

export async function insertSupabaseRows(table, rows, { upsert = false, conflictColumns = [] } = {}) {
  if (!rows.length) return [];
  const conflict = conflictColumns.length
    ? `?on_conflict=${encodeURIComponent(conflictColumns.join(","))}`
    : "";
  return request(`${table}${conflict}`, {
    method: "POST",
    headers: {
      Prefer: upsert
        ? "resolution=merge-duplicates,return=representation"
        : "return=representation",
    },
    body: JSON.stringify(rows),
  });
}

export async function updateSupabaseRows(table, values, filters = []) {
  const params = filters.map(([column, operator, value]) =>
    `${encodeURIComponent(column)}=${operator}.${queryValue(value)}`,
  );
  return request(`${table}?${params.join("&")}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(values),
  });
}

export async function deleteSupabaseRows(table, filters = []) {
  const params = filters.map(([column, operator, value]) =>
    `${encodeURIComponent(column)}=${operator}.${queryValue(value)}`,
  );
  return request(`${table}?${params.join("&")}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
}

export async function upsertSupabaseRows(table, rows, conflictColumns) {
  if (!rows.length) return 0;
  let written = 0;
  for (const batch of chunks(rows)) {
    const conflict = encodeURIComponent(conflictColumns.join(","));
    await request(`${table}?on_conflict=${conflict}`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(batch),
    });
    written += batch.length;
  }
  return written;
}

export async function deleteExpiredMonthlyMetrics(retainFromMonth) {
  const cutoff = encodeURIComponent(`lt.${retainFromMonth}`);
  await request(`audit_product_month_metrics?month=${cutoff}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
  await request(`audit_store_month_metrics?month=${cutoff}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
}
