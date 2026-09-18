import { getProductCatalog } from "./product-catalog-cache.server";
import { runShopifyQL } from "./shopifyql.server";
import {
  deleteExpiredMonthlyMetrics,
  deleteSupabaseRows,
  insertSupabaseRows,
  selectSupabaseRows,
  updateSupabaseRows,
  upsertSupabaseRows,
} from "./supabase-analytics.server";

const MONTH_COUNT = 18;
const QUERY_CONCURRENCY = 2;
const MONTH_ATTEMPTS = 3;
const RETRY_BASE_MS = 1500;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const numericId = (value) => String(value ?? "").replace(/\D/g, "");
const number = (value) => Number(value) || 0;
const dateString = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};
const monthString = (date) => dateString(date).slice(0, 7);

function shiftMonth(month, offset) {
  const [year, value] = month.split("-").map(Number);
  return monthString(new Date(year, value - 1 + offset, 1));
}

function syncMonths(now = new Date()) {
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const newest = monthString(yesterday);
  return Array.from({ length: MONTH_COUNT }, (_, index) => shiftMonth(newest, -index));
}

function monthBounds(month, today = new Date()) {
  const [year, value] = month.split("-").map(Number);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const naturalEnd = new Date(year, value, 0);
  return {
    start: `${month}-01`,
    end: dateString(naturalEnd > yesterday ? yesterday : naturalEnd),
  };
}

function retryable(message = "") {
  return /rate limit|throttl|temporar|timeout|timed out|service unavailable|internal server|502|503|504/i.test(message);
}

async function mapConcurrent(items, limit, worker) {
  const output = new Array(items.length);
  let next = 0;
  async function consume() {
    while (next < items.length) {
      const index = next++;
      output[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, consume));
  return output;
}

async function fetchShop(admin) {
  const response = await admin.graphql(`#graphql
    query SupabaseAnalyticsShop {
      shop { currencyCode myshopifyDomain }
    }
  `);
  const json = await response.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return {
    domain: json.data?.shop?.myshopifyDomain || "",
    currency: json.data?.shop?.currencyCode || "USD",
  };
}

function currencyScale(currency) {
  try {
    const digits = new Intl.NumberFormat("en", {
      style: "currency",
      currency,
    }).resolvedOptions().maximumFractionDigits;
    return 10 ** digits;
  } catch {
    return 100;
  }
}

async function ensureStore(shop) {
  const rows = await insertSupabaseRows("audit_stores", [{
    shop_domain: shop.domain,
    currency_code: shop.currency,
    status: "active",
    updated_at: new Date().toISOString(),
  }], { upsert: true, conflictColumns: ["shop_domain"] });
  return rows[0];
}

async function syncCatalog(storeId, products) {
  const now = new Date().toISOString();
  const rows = products.map((product) => ({
    store_id: storeId,
    shopify_product_id: numericId(product.id),
    title: product.title || "",
    handle: product.handle || "",
    product_type: product.productType || "",
    status: product.status || "",
    image_url: product.featuredImage?.url || "",
    shopify_created_at: product.createdAt || null,
    last_synced_at: now,
  }));
  await upsertSupabaseRows("audit_products", rows, ["store_id", "shopify_product_id"]);

  const stored = await selectSupabaseRows("audit_products", {
    select: "id,shopify_product_id,handle",
    filters: [["store_id", "eq", storeId]],
  });
  const byShopifyId = new Map(stored.map((row) => [String(row.shopify_product_id), row]));
  const internalIds = stored.map((row) => row.id);
  for (let index = 0; index < internalIds.length; index += 500) {
    const ids = internalIds.slice(index, index + 500).join(",");
    await deleteSupabaseRows("audit_product_tags", [["product_id", "in", `(${ids})`]]);
  }
  const tags = products.flatMap((product) => {
    const storedProduct = byShopifyId.get(numericId(product.id));
    return storedProduct
      ? (product.tags || []).map((tag) => ({ product_id: storedProduct.id, tag }))
      : [];
  });
  await upsertSupabaseRows("audit_product_tags", tags, ["product_id", "tag"]);
  return { byShopifyId, stored, rowsWritten: rows.length + tags.length };
}

function handleFromPath(path) {
  const match = String(path || "").match(/\/products\/([^/?#]+)/);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

async function fetchMonthOnce(admin, month, now) {
  const { start, end } = monthBounds(month, now);
  const queries = [
    ["inventory", `FROM inventory SHOW starting_inventory_units, ending_inventory_units, first_day_in_inventory GROUP BY product_id SINCE ${start} UNTIL ${end}`],
    ["sales", `FROM sales SHOW orders, quantity_ordered, net_items_sold, reversed_quantity, gross_sales, discounts, gross_sales_reversals, net_sales, shipping_charges, return_fees, taxes, total_sales GROUP BY product_id SINCE ${start} UNTIL ${end}`],
    ["sessions", `FROM sessions SHOW sessions WHERE landing_page_type = 'product' GROUP BY landing_page_path SINCE ${start} UNTIL ${end}`],
    ["store", `FROM sales SHOW orders, total_sales SINCE ${start} UNTIL ${end}`],
  ];
  const results = await mapConcurrent(queries, QUERY_CONCURRENCY, async ([name, query]) => [
    name,
    await runShopifyQL(admin, query),
  ]);
  const output = Object.fromEntries(results);
  const failures = Object.entries(output).filter(([, result]) => result.error || result.truncated);
  if (failures.length) {
    const message = failures.map(([name, result]) =>
      `${name}: ${result.error || "result reached the row limit"}`,
    ).join("; ");
    const error = new Error(message);
    error.retryable = failures.some(([, result]) => retryable(result.error));
    throw error;
  }
  return { ...output, start, end };
}

async function fetchMonth(admin, month, now) {
  for (let attempt = 1; attempt <= MONTH_ATTEMPTS; attempt += 1) {
    try {
      return { ...(await fetchMonthOnce(admin, month, now)), attempts: attempt };
    } catch (error) {
      if (!error.retryable || attempt === MONTH_ATTEMPTS) throw error;
      await wait(RETRY_BASE_MS * 2 ** (attempt - 1));
    }
  }
  throw new Error(`Could not fetch ${month}.`);
}

async function persistMonth({ store, month, result, catalog, currency }) {
  const inventory = new Map(result.inventory.rows.map((row) => [numericId(row.product_id), row]));
  const sales = new Map(result.sales.rows.map((row) => [numericId(row.product_id), row]));
  const sessions = new Map();
  const byHandle = new Map(catalog.stored.map((row) => [row.handle, String(row.shopify_product_id)]));
  for (const row of result.sessions.rows) {
    const productId = byHandle.get(handleFromPath(row.landing_page_path));
    if (productId) sessions.set(productId, (sessions.get(productId) || 0) + number(row.sessions));
  }

  const scale = currencyScale(currency);
  const ids = new Set([...inventory.keys(), ...sales.keys(), ...sessions.keys()]);
  const metrics = [...ids].flatMap((shopifyId) => {
    const product = catalog.byShopifyId.get(shopifyId);
    if (!product) return [];
    const stock = inventory.get(shopifyId) || {};
    const sold = sales.get(shopifyId) || {};
    const money = (key) => Math.round(number(sold[key]) * scale);
    return [{
      store_id: store.id,
      product_id: product.id,
      month: `${month}-01`,
      first_day_in_inventory: stock.first_day_in_inventory || null,
      starting_inventory: stock.starting_inventory_units ?? null,
      ending_inventory: stock.ending_inventory_units ?? null,
      landing_sessions: sessions.get(shopifyId) || 0,
      orders: number(sold.orders),
      quantity_ordered: number(sold.quantity_ordered),
      net_items_sold: number(sold.net_items_sold),
      reversed_quantity: number(sold.reversed_quantity),
      gross_sales_minor: money("gross_sales"),
      discounts_minor: money("discounts"),
      sales_reversals_minor: money("gross_sales_reversals"),
      net_sales_minor: money("net_sales"),
      shipping_charges_minor: money("shipping_charges"),
      return_fees_minor: money("return_fees"),
      taxes_minor: money("taxes"),
      total_sales_minor: money("total_sales"),
      refreshed_at: new Date().toISOString(),
    }];
  });
  await upsertSupabaseRows("audit_product_month_metrics", metrics, ["store_id", "product_id", "month"]);

  const storeRow = result.store.rows[0] || {};
  const activeProducts = metrics.filter((row) =>
    number(row.starting_inventory) > 0 ||
    number(row.ending_inventory) > 0 ||
    number(row.total_sales_minor) > 0,
  ).length;
  await upsertSupabaseRows("audit_store_month_metrics", [{
    store_id: store.id,
    month: `${month}-01`,
    active_products: activeProducts,
    starting_inventory: metrics.reduce((sum, row) => sum + number(row.starting_inventory), 0),
    ending_inventory: metrics.reduce((sum, row) => sum + number(row.ending_inventory), 0),
    unique_orders: number(storeRow.orders),
    landing_sessions: metrics.reduce((sum, row) => sum + number(row.landing_sessions), 0),
    total_sales_minor: Math.round(number(storeRow.total_sales) * scale),
    refreshed_at: new Date().toISOString(),
  }], ["store_id", "month"]);
  return metrics.length + 1;
}

async function updateJob(jobId, values) {
  await updateSupabaseRows("audit_sync_jobs", values, [["id", "eq", jobId]]);
}

async function preventOverlappingSync(storeId) {
  const running = await selectSupabaseRows("audit_sync_jobs", {
    select: "id,started_at",
    filters: [
      ["store_id", "eq", storeId],
      ["status", "eq", "running"],
    ],
    order: "created_at.desc",
    limit: 1,
  });
  if (!running.length) return;

  const startedAt = new Date(running[0].started_at || 0).getTime();
  const stale = !Number.isFinite(startedAt) || Date.now() - startedAt > 2 * 60 * 60 * 1000;
  if (!stale) {
    const error = new Error("A monthly analytics sync is already running for this store.");
    error.code = "SYNC_ALREADY_RUNNING";
    throw error;
  }
  await updateJob(running[0].id, {
    status: "failed",
    error_message: "Sync was automatically closed after remaining in progress for more than two hours.",
    completed_at: new Date().toISOString(),
  });
}

export async function syncLatest18MonthsToSupabase(admin, session, {
  now = new Date(),
  months: requestedMonths = null,
} = {}) {
  const shopInfo = await fetchShop(admin);
  if (!shopInfo.domain) shopInfo.domain = session.shop;
  const store = await ensureStore(shopInfo);
  await preventOverlappingSync(store.id);
  const months = requestedMonths?.length
    ? [...new Set(requestedMonths)].filter((month) => /^\d{4}-\d{2}$/.test(month))
    : syncMonths(now);
  if (!months.length) throw new Error("No valid months were provided for the analytics sync.");
  const [job] = await insertSupabaseRows("audit_sync_jobs", [{
    store_id: store.id,
    job_type: requestedMonths?.length ? "monthly_targeted_retry" : "monthly_18_month_backfill",
    status: "running",
    range_start: `${months.at(-1)}-01`,
    range_end: monthBounds(months[0], now).end,
    attempts: 1,
    started_at: new Date().toISOString(),
    details: { totalMonths: months.length, completedMonths: [], failedMonths: [] },
  }]);

  let rowsWritten = 0;
  const completedMonths = [];
  const failedMonths = [];
  try {
    const productCatalog = await getProductCatalog(admin, session.shop);
    const catalog = await syncCatalog(store.id, productCatalog.products);
    rowsWritten += catalog.rowsWritten;

    for (const month of months) {
      await updateJob(job.id, {
        details: { totalMonths: months.length, currentMonth: month, completedMonths, failedMonths },
      });
      try {
        const result = await fetchMonth(admin, month, now);
        rowsWritten += await persistMonth({ store, month, result, catalog, currency: shopInfo.currency });
        completedMonths.push(month);
      } catch (error) {
        failedMonths.push({ month, error: error.message });
      }
      await updateJob(job.id, {
        rows_written: rowsWritten,
        details: { totalMonths: months.length, completedMonths, failedMonths },
      });
      await wait(400);
    }

    // Retention belongs only to a complete rolling-window sync. A targeted
    // retry must never treat its one month as the new retention boundary.
    if (!requestedMonths?.length)
      await deleteExpiredMonthlyMetrics(`${months.at(-1)}-01`);
    const status = failedMonths.length ? "partial" : "completed";
    await updateJob(job.id, {
      status,
      rows_written: rowsWritten,
      error_message: failedMonths.length ? `${failedMonths.length} month(s) failed.` : null,
      details: { totalMonths: months.length, completedMonths, failedMonths },
      completed_at: new Date().toISOString(),
    });
    return { jobId: job.id, status, rowsWritten, completedMonths, failedMonths };
  } catch (error) {
    await updateJob(job.id, {
      status: "failed",
      rows_written: rowsWritten,
      error_message: error.message,
      details: { totalMonths: months.length, completedMonths, failedMonths },
      completed_at: new Date().toISOString(),
    });
    throw error;
  }
}

export async function latestSupabaseSync(shopDomain) {
  const stores = await selectSupabaseRows("audit_stores", {
    select: "id",
    filters: [["shop_domain", "eq", shopDomain]],
    limit: 1,
  });
  if (!stores.length) return null;
  const jobs = await selectSupabaseRows("audit_sync_jobs", {
    select: "id,status,range_start,range_end,attempts,rows_written,error_message,details,created_at,started_at,completed_at",
    filters: [["store_id", "eq", stores[0].id]],
    order: "created_at.desc",
    limit: 1,
  });
  return jobs[0] || null;
}
