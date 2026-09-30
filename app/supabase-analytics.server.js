import { shopifyIdText } from "./shopify-id.js";

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

function writeCounts(value = {}) {
  return {
    rowsProcessed: Number(value?.rows_processed) || 0,
    rowsInserted: Number(value?.rows_inserted) || 0,
    rowsUpdated: Number(value?.rows_updated) || 0,
    rowsDeleted: Number(value?.rows_deleted) || 0,
  };
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
  if (limit > 0) {
    params.push(`limit=${limit}`);
    return request(`${table}?${params.join("&")}`);
  }

  // PostgREST returns at most 1,000 rows by default. Read every page so large
  // Shopify catalogues are not silently reduced to their first 1,000 products.
  const pageSize = 1000;
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await request(`${table}?${params.join("&")}`, {
      headers: { Range: `${offset}-${offset + pageSize - 1}` },
    });
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
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

export async function replaceSupabaseStoreMonth({
  storeId,
  month,
  productMetrics,
  storeMetrics,
}) {
  if (storeId === undefined || storeId === null || storeId === "") {
    throw new Error("A store ID is required before replacing monthly metrics.");
  }
  if (!/^\d{4}-\d{2}-01$/.test(String(month))) {
    throw new Error("A valid first-of-month date is required before replacing monthly metrics.");
  }
  if (!Array.isArray(productMetrics)) {
    throw new Error("Product metrics must be a complete array before replacing a month.");
  }
  if (!storeMetrics || typeof storeMetrics !== "object" || Array.isArray(storeMetrics)) {
    throw new Error("Store metrics are required before replacing a month.");
  }

  const result = await request("rpc/replace_audit_store_month_with_counts", {
    method: "POST",
    body: JSON.stringify({
      p_store_id: storeId,
      p_month: month,
      p_product_metrics: productMetrics,
      p_store_metrics: storeMetrics,
    }),
  });
  return writeCounts(result);
}

export async function deleteExpiredMonthlyMetrics(storeId, retainFromMonth) {
  if (storeId === undefined || storeId === null || storeId === "") {
    throw new Error("A store ID is required before deleting expired monthly metrics.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(retainFromMonth))) {
    throw new Error("A valid retention month is required before deleting expired monthly metrics.");
  }

  const result = await request("rpc/delete_expired_audit_monthly_metrics_with_counts", {
    method: "POST",
    body: JSON.stringify({
      p_store_id: storeId,
      p_retain_from_month: retainFromMonth,
    }),
  });
  return writeCounts(result);
}

export function reconcileSupabaseProductCatalog(storeId, shopifyProductIds, seenAt) {
  const textIds = [...new Set(shopifyProductIds.map(shopifyIdText).filter(Boolean))];
  return request("rpc/reconcile_audit_product_catalog", {
    method: "POST",
    body: JSON.stringify({
      p_store_id: storeId,
      p_seen_product_ids: textIds,
      p_seen_at: seenAt,
    }),
  });
}

export function markSupabaseProductDeleted(storeId, shopifyProductId, deletedAt) {
  const textId = shopifyIdText(shopifyProductId);
  if (!textId) throw new Error("A Shopify product ID is required before marking a product deleted.");
  return request("rpc/mark_audit_product_deleted", {
    method: "POST",
    body: JSON.stringify({
      p_store_id: storeId,
      p_shopify_product_id: textId,
      p_deleted_at: deletedAt,
    }),
  });
}

export function cleanupSupabaseOrphanProducts(storeId, graceBefore) {
  return request("rpc/cleanup_audit_orphan_products", {
    method: "POST",
    body: JSON.stringify({
      p_store_id: storeId,
      p_grace_before: graceBefore,
    }),
  });
}

export function ensureSupabaseUnattributedProduct(storeId) {
  if (storeId === undefined || storeId === null || storeId === "") {
    throw new Error("A store ID is required before creating the unattributed product bucket.");
  }
  return request("rpc/ensure_audit_unattributed_product", {
    method: "POST",
    body: JSON.stringify({ p_store_id: storeId }),
  });
}

export function reconcileSupabaseProductHandles(storeId, handles, seenAt) {
  const textHandles = handles.map((item) => ({
    ...item,
    shopify_product_id: shopifyIdText(item.shopify_product_id),
  }));
  return request("rpc/reconcile_audit_product_handles", {
    method: "POST",
    body: JSON.stringify({
      p_store_id: storeId,
      p_handles: textHandles,
      p_seen_at: seenAt,
    }),
  });
}

export async function replaceSupabaseProductTags(storeId, refreshedProductIds, tags) {
  if (storeId === undefined || storeId === null || storeId === "") {
    throw new Error("A store ID is required before replacing product tags.");
  }
  if (!Array.isArray(refreshedProductIds) || !Array.isArray(tags)) {
    throw new Error("Complete refreshed product IDs and tags are required.");
  }
  const result = await request("rpc/replace_audit_product_tags_with_counts", {
    method: "POST",
    body: JSON.stringify({
      p_store_id: storeId,
      p_refreshed_product_ids: [...new Set(refreshedProductIds.map(Number))],
      p_tags: tags,
    }),
  });
  return writeCounts(result);
}
