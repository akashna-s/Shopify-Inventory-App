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
