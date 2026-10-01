import { refreshProductCatalog } from "./product-catalog-cache.server";
import { runShopifyQL } from "./shopifyql.server";
import { createAuthenticatedStoreAnalytics } from "./store-analytics-access.server";
import { sumNonNegativeInventory } from "./inventory-rules.server";
import { matchLandingSessions } from "./landing-session-matcher.server";
import { shopifyIdText } from "./shopify-id.js";
import {
  latestSyncMonths,
  normalizeIanaTimeZone,
  storeMonthBounds,
} from "./store-calendar.server";
import {
  addSyncProgress,
  createSyncProgress,
  shortErrorSummary,
  syncProgressFields,
} from "./sync-progress.server";

const MONTH_COUNT = 18;
const QUERY_CONCURRENCY = 2;
const MONTH_ATTEMPTS = 3;
const RETRY_BASE_MS = 1500;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const number = (value) => Number(value) || 0;
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
      shop { currencyCode myshopifyDomain ianaTimezone }
    }
  `);
  const json = await response.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return {
    domain: json.data?.shop?.myshopifyDomain || "",
    currency: json.data?.shop?.currencyCode || "USD",
    timeZone: normalizeIanaTimeZone(json.data?.shop?.ianaTimezone),
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

async function syncCatalog(analytics, products) {
  const now = new Date().toISOString();
  const existing = await analytics.selectProducts({
    select: "id,shopify_product_id,record_kind",
  });
  const existingShopifyIds = new Set(
    existing
      .filter((product) => product.record_kind !== "unattributed")
      .map((product) => String(product.shopify_product_id)),
  );
  const hadUnattributedProduct = existing.some(
    (product) => product.record_kind === "unattributed",
  );
  const rows = products.map((product) => ({
    shopify_product_id: shopifyIdText(product.id),
    title: product.title || "",
    handle: product.handle || "",
    product_type: product.productType || "",
    status: product.status || "",
    image_url: product.featuredImage?.url || "",
    shopify_created_at: product.createdAt || null,
    catalog_state: "present",
    last_seen_at: now,
    missing_since: null,
    deleted_at: null,
    last_synced_at: now,
    record_kind: "shopify",
  }));
  await analytics.upsertProducts(rows);

  const stored = await analytics.selectProducts({
    select: "id,shopify_product_id,title,product_type,handle,record_kind",
    filters: [["record_kind", "eq", "shopify"]],
  });
  const byShopifyId = new Map(stored.map((row) => [String(row.shopify_product_id), row]));
  const tags = products.flatMap((product) => {
    const storedProduct = byShopifyId.get(shopifyIdText(product.id));
    return storedProduct
      ? (product.tags || []).map((tag) => ({ product_id: storedProduct.id, tag }))
      : [];
  });
  const refreshedProductIds = products
    .map((product) => byShopifyId.get(shopifyIdText(product.id))?.id)
    .filter(Boolean);
  const tagCounts = await analytics.replaceProductTags(tags, refreshedProductIds);
  await analytics.reconcileCatalog(
    products.map((product) => shopifyIdText(product.id)),
    now,
  );
  await analytics.reconcileProductHandles(
    products.map((product) => ({
      shopify_product_id: shopifyIdText(product.id),
      handle: product.handle || "",
      valid_from: product.createdAt || now,
    })),
    now,
  );
  const unattributedProductId = await analytics.ensureUnattributedProduct();
  const insertedProducts = rows.filter((row) =>
    !existingShopifyIds.has(String(row.shopify_product_id)),
  ).length;
  return {
    byShopifyId,
    stored,
    unattributedProduct: {
      id: unattributedProductId,
      title: "Unattributed Shopify Data",
      product_type: "Unknown",
      handle: "",
    },
    progress: {
      rowsProcessed: rows.length + 1 + (tagCounts.rowsProcessed || 0),
      rowsInserted: insertedProducts + (hadUnattributedProduct ? 0 : 1) + (tagCounts.rowsInserted || 0),
      rowsUpdated: rows.length - insertedProducts + (hadUnattributedProduct ? 1 : 0) + (tagCounts.rowsUpdated || 0),
      rowsDeleted: tagCounts.rowsDeleted || 0,
    },
  };
}

function aggregateUnattributedRows(rows, fields) {
  const missingIdRows = rows.filter((row) => !shopifyIdText(row.product_id));
  if (!missingIdRows.length) return null;
  return Object.fromEntries(
    fields.map((field) => [
      field,
      missingIdRows.reduce((sum, row) => sum + number(row[field]), 0),
    ]),
  );
}

async function fetchMonthOnce(admin, month, now, timeZone) {
  const { start, end } = storeMonthBounds(month, now, timeZone);
  const queries = [
    ["inventory", `FROM inventory SHOW starting_inventory_units, ending_inventory_units, first_day_in_inventory GROUP BY product_id SINCE ${start} UNTIL ${end}`],
    ["sales", `FROM sales SHOW orders, quantity_ordered, net_items_sold, reversed_quantity, gross_sales, discounts, gross_sales_reversals, net_sales, shipping_charges, return_fees, taxes, total_sales GROUP BY product_id SINCE ${start} UNTIL ${end}`],
    ["sessions", `FROM sessions SHOW sessions WHERE landing_page_type = 'product' GROUP BY landing_page_path SINCE ${start} UNTIL ${end}`],
    ["storeSessions", `FROM sessions SHOW sessions SINCE ${start} UNTIL ${end}`],
    ["store", `FROM sales SHOW orders, total_sales SINCE ${start} UNTIL ${end}`],
  ];
  const results = await mapConcurrent(queries, QUERY_CONCURRENCY, async ([name, query]) => [
    name,
    await runShopifyQL(admin, query),
  ]);
  const output = Object.fromEntries(results);
  const queryAttemptCount = Object.values(output).reduce(
    (total, result) => total + Math.max(1, Number(result.attempts) || 1),
    0,
  );
  const failures = Object.entries(output).filter(([, result]) => result.error || result.truncated);
  if (failures.length) {
    const message = failures.map(([name, result]) =>
      `${name}: ${result.error || "result reached the row limit"}`,
    ).join("; ");
    const error = new Error(message);
    error.retryable = failures.some(([, result]) => retryable(result.error));
    error.queryAttemptCount = queryAttemptCount;
    error.queryCount = queries.length;
    throw error;
  }
  return { ...output, start, end, queryAttemptCount, queryCount: queries.length };
}

async function fetchMonth(admin, month, now, timeZone) {
  let totalQueryAttempts = 0;
  let queryCount = 5;
  for (let attempt = 1; attempt <= MONTH_ATTEMPTS; attempt += 1) {
    try {
      const result = await fetchMonthOnce(admin, month, now, timeZone);
      totalQueryAttempts += result.queryAttemptCount;
      queryCount = result.queryCount;
      return {
        ...result,
        attempts: attempt,
        queryRetryCount: Math.max(0, totalQueryAttempts - queryCount),
      };
    } catch (error) {
      totalQueryAttempts += Number(error.queryAttemptCount) || 0;
      queryCount = Number(error.queryCount) || queryCount;
      if (!error.retryable || attempt === MONTH_ATTEMPTS) {
        error.queryRetryCount = Math.max(0, totalQueryAttempts - queryCount);
        error.monthAttemptCount = attempt;
        throw error;
      }
      await wait(RETRY_BASE_MS * 2 ** (attempt - 1));
    }
  }
  throw new Error(`Could not fetch ${month}.`);
}

async function persistMonth({ analytics, month, result, catalog, currency }) {
  const inventory = new Map(
    result.inventory.rows
      .map((row) => [shopifyIdText(row.product_id), row])
      .filter(([productId]) => productId),
  );
  const sales = new Map(
    result.sales.rows
      .map((row) => [shopifyIdText(row.product_id), row])
      .filter(([productId]) => productId),
  );
  const unattributedInventory = aggregateUnattributedRows(result.inventory.rows, [
    "starting_inventory_units",
    "ending_inventory_units",
  ]);
  const unattributedSales = aggregateUnattributedRows(result.sales.rows, [
    "orders",
    "quantity_ordered",
    "net_items_sold",
    "reversed_quantity",
    "gross_sales",
    "discounts",
    "gross_sales_reversals",
    "net_sales",
    "shipping_charges",
    "return_fees",
    "taxes",
    "total_sales",
  ]);
  const monthStart = `${month}-01`;
  const monthEnd = result.end;
  const handleHistory = await analytics.selectProductHandleHistory({
    select: "product_id,shopify_product_id,handle,valid_from,valid_to",
    filters: [
      ["valid_from", "lte", `${monthEnd}T23:59:59.999Z`],
      ["valid_to", "is", "null"],
    ],
  });
  // Include closed aliases that were valid at any point in the requested month.
  const closedHistory = await analytics.selectProductHandleHistory({
    select: "product_id,shopify_product_id,handle,valid_from,valid_to",
    filters: [
      ["valid_from", "lte", `${monthEnd}T23:59:59.999Z`],
      ["valid_to", "gte", `${monthStart}T00:00:00.000Z`],
    ],
  });
  const { matched: sessions, unmatched } = matchLandingSessions(
    result.sessions.rows,
    [...handleHistory, ...closedHistory],
  );

  const scale = currencyScale(currency);
  const ids = new Set([...inventory.keys(), ...sales.keys(), ...sessions.keys()]);
  const metrics = [...ids].flatMap((shopifyId) => {
    const product = catalog.byShopifyId.get(shopifyId);
    if (!product) return [];
    const stock = inventory.get(shopifyId) || {};
    const sold = sales.get(shopifyId) || {};
    const money = (key) => Math.round(number(sold[key]) * scale);
    return [{
      product_id: product.id,
      currency_code: currency,
      title_snapshot: product.title || "",
      product_type_snapshot: product.product_type || "",
      handle_snapshot: product.handle || "",
      first_day_in_inventory: stock.first_day_in_inventory || null,
      starting_inventory: stock.starting_inventory_units ?? null,
      ending_inventory: stock.ending_inventory_units ?? null,
      landing_sessions: sessions.get(shopifyId) || 0,
      product_orders: number(sold.orders),
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
  if (
    catalog.unattributedProduct?.id &&
    (unattributedInventory || unattributedSales)
  ) {
    const stock = unattributedInventory || {};
    const sold = unattributedSales || {};
    const money = (key) => Math.round(number(sold[key]) * scale);
    metrics.push({
      product_id: catalog.unattributedProduct.id,
      currency_code: currency,
      title_snapshot: catalog.unattributedProduct.title,
      product_type_snapshot: catalog.unattributedProduct.product_type,
      handle_snapshot: "",
      first_day_in_inventory: null,
      starting_inventory: unattributedInventory
        ? number(stock.starting_inventory_units)
        : null,
      ending_inventory: unattributedInventory
        ? number(stock.ending_inventory_units)
        : null,
      // A missing Product ID gives us no defensible product handle, so landing
      // sessions and conversion are intentionally unavailable for this bucket.
      landing_sessions: 0,
      product_orders: number(sold.orders),
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
    });
  }
  const storeRow = result.store.rows[0] || {};
  const directStoreSessionRow = result.storeSessions.rows[0] || {};
  const matchedLandingSessions = metrics.reduce((sum, row) => sum + number(row.landing_sessions), 0);
  const unmatchedLandingSessions = [...unmatched.values()].reduce((sum, value) => sum + value, 0);
  const activeProducts = metrics.filter((row) =>
    row.product_id !== catalog.unattributedProduct?.id &&
    (number(row.starting_inventory) > 0 ||
      number(row.ending_inventory) > 0 ||
      number(row.total_sales_minor) > 0),
  ).length;
  const storeMetrics = {
    currency_code: currency,
    active_products: activeProducts,
    // Product-month facts keep Shopify's raw values for auditing. Store-month
    // report totals treat each negative product balance as zero.
    non_negative_starting_inventory: sumNonNegativeInventory(
      metrics,
      "starting_inventory",
    ),
    non_negative_ending_inventory: sumNonNegativeInventory(
      metrics,
      "ending_inventory",
    ),
    unique_orders: number(storeRow.orders),
    // Keep the existing field as matched product landing sessions for report compatibility.
    landing_sessions: matchedLandingSessions,
    matched_product_landing_sessions: matchedLandingSessions,
    unmatched_product_landing_sessions: unmatchedLandingSessions,
    store_sessions: number(directStoreSessionRow.sessions),
    unmatched_landing_pages: [...unmatched].map(([handle, sessionCount]) => ({
      handle,
      sessions: sessionCount,
    })),
    total_sales_minor: Math.round(number(storeRow.total_sales) * scale),
    refreshed_at: new Date().toISOString(),
  };
  return analytics.replaceMonth({
    month: `${month}-01`,
    productMetrics: metrics,
    storeMetrics,
  });
}

async function preventOverlappingSync(analytics) {
  const running = await analytics.selectJobs({
    select: "id,started_at",
    filters: [
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
  await analytics.updateJob(running[0].id, {
    status: "failed",
    error_message: "Sync was automatically closed after remaining in progress for more than two hours.",
    error_summary: "Sync automatically closed after running for more than two hours.",
    completed_at: new Date().toISOString(),
  });
}

export async function syncLatest18MonthsToSupabase(admin, session, {
  now = new Date(),
  months: requestedMonths = null,
} = {}) {
  const shopInfo = await fetchShop(admin);
  const analytics = await createAuthenticatedStoreAnalytics(session, {
    createStore: true,
    currencyCode: shopInfo.currency,
    ianaTimeZone: shopInfo.timeZone,
  });
  await preventOverlappingSync(analytics);
  const months = requestedMonths?.length
    ? [...new Set(requestedMonths)].filter((month) => /^\d{4}-\d{2}$/.test(month))
    : latestSyncMonths(now, shopInfo.timeZone, MONTH_COUNT);
  if (!months.length) throw new Error("No valid months were provided for the analytics sync.");
  const progress = createSyncProgress(1);
  const [job] = await analytics.createJob({
    job_type: requestedMonths?.length ? "monthly_targeted_retry" : "monthly_18_month_backfill",
    status: "running",
    range_start: `${months.at(-1)}-01`,
    range_end: storeMonthBounds(months[0], now, shopInfo.timeZone).end,
    ...syncProgressFields(progress),
    started_at: new Date().toISOString(),
    details: {
      totalMonths: months.length,
      completedMonths: [],
      failedMonths: [],
      progress: syncProgressFields(progress),
    },
  });

  const completedMonths = [];
  const failedMonths = [];
  try {
    const productCatalog = await refreshProductCatalog(admin, session.shop);
    const catalog = await syncCatalog(analytics, productCatalog.products);
    addSyncProgress(progress, catalog.progress);

    for (const month of months) {
      await analytics.updateJob(job.id, {
        ...syncProgressFields(progress),
        details: {
          totalMonths: months.length,
          currentMonth: month,
          completedMonths,
          failedMonths,
          progress: syncProgressFields(progress),
        },
      });
      try {
        const result = await fetchMonth(admin, month, now, shopInfo.timeZone);
        addSyncProgress(progress, { queryRetryCount: result.queryRetryCount });
        const monthCounts = await persistMonth({
          analytics,
          month,
          result,
          catalog,
          currency: shopInfo.currency,
        });
        addSyncProgress(progress, monthCounts);
        completedMonths.push(month);
      } catch (error) {
        addSyncProgress(progress, { queryRetryCount: error.queryRetryCount });
        failedMonths.push({
          month,
          error: shortErrorSummary(error),
          monthAttempts: error.monthAttemptCount || 1,
          queryRetries: error.queryRetryCount || 0,
        });
      }
      await analytics.updateJob(job.id, {
        ...syncProgressFields(progress),
        details: {
          totalMonths: months.length,
          completedMonths,
          failedMonths,
          progress: syncProgressFields(progress),
        },
      });
      await wait(400);
    }

    // Retention belongs only to a complete rolling-window sync. A targeted
    // retry must never treat its one month as the new retention boundary.
    if (!requestedMonths?.length) {
      const cleanupCounts = await analytics.deleteExpiredMonths(`${months.at(-1)}-01`);
      addSyncProgress(progress, cleanupCounts);
    }
    const status = failedMonths.length ? "partial" : "completed";
    const errorSummary = failedMonths.length ? `${failedMonths.length} month(s) failed.` : null;
    await analytics.updateJob(job.id, {
      status,
      ...syncProgressFields(progress),
      error_message: errorSummary,
      error_summary: errorSummary,
      details: {
        totalMonths: months.length,
        completedMonths,
        failedMonths,
        progress: syncProgressFields(progress),
      },
      completed_at: new Date().toISOString(),
    });
    return {
      jobId: job.id,
      status,
      ...syncProgressFields(progress),
      completedMonths,
      failedMonths,
    };
  } catch (error) {
    const errorSummary = shortErrorSummary(error);
    await analytics.updateJob(job.id, {
      status: "failed",
      ...syncProgressFields(progress),
      error_message: error.message,
      error_summary: errorSummary,
      details: {
        totalMonths: months.length,
        completedMonths,
        failedMonths,
        progress: syncProgressFields(progress),
      },
      completed_at: new Date().toISOString(),
    });
    throw error;
  }
}

export async function latestSupabaseSync(session) {
  const analytics = await createAuthenticatedStoreAnalytics(session);
  if (!analytics) return null;
  const jobs = await analytics.selectJobs({
    select: "id,status,range_start,range_end,job_attempt,query_retry_count,rows_processed,rows_inserted,rows_updated,rows_deleted,error_summary,attempts,rows_written,error_message,details,created_at,started_at,completed_at",
    order: "created_at.desc",
    limit: 1,
  });
  return jobs[0] || null;
}
