import {
  readAnalyticsCatalog,
  readAnalyticsManifest,
  removeAnalyticsMonths,
  writeAnalyticsCatalog,
  writeAnalyticsManifest,
  writeAnalyticsMonth,
} from "./analytics-file-cache.server.js";
import { sumNonNegativeInventory } from "./inventory-rules.server.js";
import { matchLandingSessions } from "./landing-session-matcher.server.js";
import { shopifyIdText } from "./shopify-id.js";
import { runShopifyQL } from "./shopifyql.server.js";
import { latestSyncMonths, storeMonthBounds } from "./store-calendar.server.js";
import {
  addSyncProgress,
  createSyncProgress,
  shortErrorSummary,
  syncProgressFields,
} from "./sync-progress.server.js";

const MONTH_COUNT = 18;
const QUERY_CONCURRENCY = 2;
const MONTH_ATTEMPTS = 3;
const RETRY_BASE_MS = 1500;
const UNATTRIBUTED_PRODUCT_ID = "unattributed";

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

function normalizeProduct(product, refreshedAt) {
  return {
    shopifyProductId: shopifyIdText(product.id),
    title: product.title || "",
    handle: product.handle || "",
    productType: product.productType || "",
    status: product.status || "",
    imageUrl: product.featuredImage?.url || "",
    createdAt: product.createdAt || null,
    tags: [...new Set(product.tags || [])],
    catalogState: "present",
    lastSeenAt: refreshedAt,
    missingSince: null,
  };
}

export function buildFileCatalogSnapshot(products, previous, refreshedAt) {
  const previousProducts = new Map(
    (previous?.products || []).map((product) => [
      String(product.shopifyProductId),
      product,
    ]),
  );
  const current = products
    .map((product) => normalizeProduct(product, refreshedAt))
    .filter((product) => product.shopifyProductId);
  const currentIds = new Set(current.map((product) => product.shopifyProductId));
  const missing = [...previousProducts.values()]
    .filter((product) => !currentIds.has(String(product.shopifyProductId)))
    .map((product) => ({
      ...product,
      catalogState: "missing",
      missingSince: product.missingSince || refreshedAt,
    }));

  const handleHistory = (previous?.handleHistory || []).map((entry) => ({
    ...entry,
  }));
  for (const product of current) {
    const active = handleHistory.filter(
      (entry) =>
        String(entry.shopify_product_id) === product.shopifyProductId &&
        !entry.valid_to,
    );
    const currentHandle = product.handle.trim().toLowerCase();
    const matching = active.find(
      (entry) => String(entry.handle || "").trim().toLowerCase() === currentHandle,
    );
    if (matching) {
      matching.last_seen_at = refreshedAt;
      continue;
    }
    for (const entry of active) entry.valid_to = refreshedAt;
    if (currentHandle) {
      handleHistory.push({
        shopify_product_id: product.shopifyProductId,
        handle: currentHandle,
        valid_from: previousProducts.has(product.shopifyProductId)
          ? refreshedAt
          : product.createdAt || refreshedAt,
        valid_to: null,
        last_seen_at: refreshedAt,
      });
    }
  }

  return {
    refreshedAt,
    products: [...current, ...missing],
    handleHistory,
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
    ["sessions", `FROM sessions SHOW sessions, sessions_that_completed_checkout WHERE landing_page_type = 'product' GROUP BY landing_page_path SINCE ${start} UNTIL ${end}`],
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
  const failures = Object.entries(output).filter(
    ([, result]) => result.error || result.truncated,
  );
  if (failures.length) {
    const error = new Error(
      failures
        .map(([name, result]) =>
          `${name}: ${result.error || "result reached the row limit"}`,
        )
        .join("; "),
    );
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

function historyForMonth(handleHistory, month, monthEnd) {
  const monthStart = `${month}-01T00:00:00.000Z`;
  const monthEndTime = `${monthEnd}T23:59:59.999Z`;
  return handleHistory.filter(
    (entry) =>
      String(entry.valid_from || "") <= monthEndTime &&
      (!entry.valid_to || String(entry.valid_to) >= monthStart),
  );
}

export function buildFileMonthPayload({ month, result, catalog, currency }) {
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
  const productById = new Map(
    catalog.products.map((product) => [String(product.shopifyProductId), product]),
  );
  const {
    matched: sessions,
    matchedCompletedCheckouts,
    unmatched,
  } = matchLandingSessions(
    result.sessions.rows,
    historyForMonth(catalog.handleHistory, month, result.end),
  );
  const scale = currencyScale(currency);
  const ids = new Set([...inventory.keys(), ...sales.keys(), ...sessions.keys()]);
  const refreshedAt = new Date().toISOString();
  const productMetrics = [...ids].map((shopifyProductId) => {
    const product = productById.get(shopifyProductId) || {
      title: `Unavailable product ${shopifyProductId}`,
      productType: "Unknown",
      handle: "",
      status: "",
      imageUrl: "",
      createdAt: null,
      tags: [],
      catalogState: "missing",
    };
    const stock = inventory.get(shopifyProductId) || {};
    const sold = sales.get(shopifyProductId) || {};
    const money = (key) => Math.round(number(sold[key]) * scale);
    return {
      shopify_product_id: shopifyProductId,
      record_kind: "shopify",
      title: product.title,
      product_type: product.productType,
      handle: product.handle,
      status: product.status,
      image_url: product.imageUrl,
      shopify_created_at: product.createdAt,
      tags: product.tags || [],
      catalog_state: product.catalogState,
      currency_code: currency,
      first_day_in_inventory: stock.first_day_in_inventory || null,
      starting_inventory: stock.starting_inventory_units ?? null,
      ending_inventory: stock.ending_inventory_units ?? null,
      landing_sessions: sessions.get(shopifyProductId) || 0,
      completed_checkout_sessions:
        matchedCompletedCheckouts.get(shopifyProductId) || 0,
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
      refreshed_at: refreshedAt,
    };
  });
  if (unattributedInventory || unattributedSales) {
    const stock = unattributedInventory || {};
    const sold = unattributedSales || {};
    const money = (key) => Math.round(number(sold[key]) * scale);
    productMetrics.push({
      shopify_product_id: UNATTRIBUTED_PRODUCT_ID,
      record_kind: "unattributed",
      title: "Unattributed Shopify Data",
      product_type: "Unknown",
      handle: "",
      status: "unattributed",
      image_url: "",
      shopify_created_at: null,
      tags: [],
      catalog_state: "unattributed",
      currency_code: currency,
      first_day_in_inventory: null,
      starting_inventory: unattributedInventory
        ? number(stock.starting_inventory_units)
        : null,
      ending_inventory: unattributedInventory
        ? number(stock.ending_inventory_units)
        : null,
      landing_sessions: 0,
      completed_checkout_sessions: 0,
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
      refreshed_at: refreshedAt,
    });
  }

  const storeRow = result.store.rows[0] || {};
  const directStoreSessionRow = result.storeSessions.rows[0] || {};
  const matchedLandingSessions = productMetrics.reduce(
    (sum, row) => sum + number(row.landing_sessions),
    0,
  );
  const unmatchedLandingSessions = [...unmatched.values()].reduce(
    (sum, value) => sum + value,
    0,
  );
  const activeProducts = productMetrics.filter(
    (row) =>
      row.record_kind === "shopify" &&
      (number(row.starting_inventory) > 0 ||
        number(row.ending_inventory) > 0 ||
        number(row.total_sales_minor) > 0),
  ).length;

  return {
    rangeStart: result.start,
    rangeEnd: result.end,
    cacheSchemaVersion: 1,
    currencyCode: currency,
    generatedAt: refreshedAt,
    productMetrics,
    storeMetrics: {
      currency_code: currency,
      active_products: activeProducts,
      non_negative_starting_inventory: sumNonNegativeInventory(
        productMetrics,
        "starting_inventory",
      ),
      non_negative_ending_inventory: sumNonNegativeInventory(
        productMetrics,
        "ending_inventory",
      ),
      unique_orders: number(storeRow.orders),
      landing_sessions: matchedLandingSessions,
      matched_product_landing_sessions: matchedLandingSessions,
      unmatched_product_landing_sessions: unmatchedLandingSessions,
      store_sessions: number(directStoreSessionRow.sessions),
      unmatched_landing_pages: [...unmatched].map(([handle, sessionsCount]) => ({
        handle,
        sessions: sessionsCount,
      })),
      total_sales_minor: Math.round(number(storeRow.total_sales) * scale),
      refreshed_at: refreshedAt,
    },
  };
}

function emptyManifest(storeId, shopInfo) {
  return {
    storeId: String(storeId),
    currencyCode: shopInfo.currency,
    ianaTimeZone: shopInfo.timeZone,
    generatedAt: null,
    catalog: null,
    months: [],
  };
}

export async function syncLatest18MonthsToFileCache({
  admin,
  analytics,
  shopInfo,
  productCatalog,
  now,
  requestedMonths,
  jobType = null,
}) {
  const months = requestedMonths?.length
    ? [...new Set(requestedMonths)].filter((month) => /^\d{4}-\d{2}$/.test(month))
    : latestSyncMonths(now, shopInfo.timeZone, MONTH_COUNT);
  if (!months.length) throw new Error("No valid months were provided for the analytics sync.");

  const storeId = analytics.store.id;
  const [previousCatalog, previousManifest] = await Promise.all([
    readAnalyticsCatalog(storeId),
    readAnalyticsManifest(storeId),
  ]);
  const refreshedAt = new Date().toISOString();
  const catalog = buildFileCatalogSnapshot(
    productCatalog.products,
    previousCatalog,
    refreshedAt,
  );
  const catalogEntry = await writeAnalyticsCatalog(storeId, catalog);
  let manifest = previousManifest || emptyManifest(storeId, shopInfo);
  manifest = {
    ...manifest,
    currencyCode: shopInfo.currency,
    ianaTimeZone: shopInfo.timeZone,
    catalog: catalogEntry,
  };

  const progress = createSyncProgress(1);
  addSyncProgress(progress, { rowsProcessed: catalog.products.length });
  const [job] = await analytics.createJob({
    job_type: jobType || (requestedMonths?.length
      ? "file_cache_monthly_targeted_retry"
      : "file_cache_monthly_18_month_backfill"),
    status: "running",
    range_start: `${months.at(-1)}-01`,
    range_end: storeMonthBounds(months[0], now, shopInfo.timeZone).end,
    ...syncProgressFields(progress),
    started_at: refreshedAt,
    details: {
      storageMode: "file_cache",
      cacheSchemaVersion: 1,
      totalMonths: months.length,
      completedMonths: [],
      failedMonths: [],
      filesWritten: 1,
      bytesWritten: catalogEntry.compressedBytes,
      progress: syncProgressFields(progress),
    },
  });

  const completedMonths = [];
  const failedMonths = [];
  let filesWritten = 1;
  let bytesWritten = catalogEntry.compressedBytes;
  const monthEntries = new Map(
    (manifest.months || []).map((entry) => [entry.month, entry]),
  );

  try {
    for (const month of months) {
      await analytics.updateJob(job.id, {
        ...syncProgressFields(progress),
        details: {
          storageMode: "file_cache",
          cacheSchemaVersion: 1,
          totalMonths: months.length,
          currentMonth: month,
          completedMonths,
          failedMonths,
          filesWritten,
          bytesWritten,
          progress: syncProgressFields(progress),
        },
      });
      try {
        const result = await fetchMonth(admin, month, now, shopInfo.timeZone);
        addSyncProgress(progress, { queryRetryCount: result.queryRetryCount });
        const payload = buildFileMonthPayload({
          month,
          result,
          catalog,
          currency: shopInfo.currency,
        });
        const previousEntry = monthEntries.get(month);
        const entry = await writeAnalyticsMonth(storeId, month, payload);
        monthEntries.set(month, entry);
        filesWritten += 1;
        bytesWritten += entry.compressedBytes;
        addSyncProgress(progress, {
          rowsProcessed: entry.productRows,
          rowsInserted: previousEntry
            ? Math.max(0, entry.productRows - previousEntry.productRows)
            : entry.productRows,
          rowsUpdated: previousEntry
            ? Math.min(entry.productRows, previousEntry.productRows)
            : 0,
          rowsDeleted: previousEntry
            ? Math.max(0, previousEntry.productRows - entry.productRows)
            : 0,
        });
        completedMonths.push(month);
        manifest = await writeAnalyticsManifest(storeId, {
          ...manifest,
          generatedAt: new Date().toISOString(),
          months: [...monthEntries.values()].sort((a, b) =>
            b.month.localeCompare(a.month),
          ),
        });
      } catch (error) {
        addSyncProgress(progress, { queryRetryCount: error.queryRetryCount });
        failedMonths.push({
          month,
          error: shortErrorSummary(error),
          monthAttempts: error.monthAttemptCount || 1,
          queryRetries: error.queryRetryCount || 0,
        });
      }
      await wait(400);
    }

    if (!requestedMonths?.length) {
      const retained = new Set(months);
      const expired = [...monthEntries.keys()].filter((month) => !retained.has(month));
      const expiredRows = expired.reduce(
        (sum, month) => sum + number(monthEntries.get(month)?.productRows),
        0,
      );
      for (const month of expired) monthEntries.delete(month);
      manifest = await writeAnalyticsManifest(storeId, {
        ...manifest,
        generatedAt: new Date().toISOString(),
        months: [...monthEntries.values()].sort((a, b) =>
          b.month.localeCompare(a.month),
        ),
      });
      if (expired.length) {
        await removeAnalyticsMonths(storeId, expired);
        addSyncProgress(progress, { rowsDeleted: expiredRows });
      }
    }

    const status = failedMonths.length ? "partial" : "completed";
    const errorSummary = failedMonths.length
      ? `${failedMonths.length} month(s) failed.`
      : null;
    await analytics.updateJob(job.id, {
      status,
      ...syncProgressFields(progress),
      error_message: errorSummary,
      error_summary: errorSummary,
      details: {
        storageMode: "file_cache",
        cacheSchemaVersion: 1,
        totalMonths: months.length,
        completedMonths,
        failedMonths,
        filesWritten,
        bytesWritten,
        progress: syncProgressFields(progress),
      },
      completed_at: new Date().toISOString(),
    });
    return {
      jobId: job.id,
      status,
      storageMode: "file_cache",
      ...syncProgressFields(progress),
      filesWritten,
      bytesWritten,
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
        storageMode: "file_cache",
        cacheSchemaVersion: 1,
        totalMonths: months.length,
        completedMonths,
        failedMonths,
        filesWritten,
        bytesWritten,
        progress: syncProgressFields(progress),
      },
      completed_at: new Date().toISOString(),
    });
    throw error;
  }
}
