import {
  readAnalyticsCatalog,
  readAnalyticsManifest,
  readAnalyticsMonth,
} from "./analytics-file-cache.server.js";
import { createAuthenticatedStoreAnalytics } from "./store-analytics-access.server.js";

const CACHE_SCHEMA_VERSION = 1;

function monthKey(value) {
  return String(value || "").slice(0, 7);
}

function monthEnd(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  const day = new Date(year, monthNumber, 0).getDate();
  return `${month}-${String(day).padStart(2, "0")}`;
}

function requestedMonths(start, end) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return [];
  }
  if (!start.endsWith("-01") || start > end) return [];
  const output = [];
  const [startYear, startMonth] = start.slice(0, 7).split("-").map(Number);
  const endKey = end.slice(0, 7);
  const cursor = new Date(Date.UTC(startYear, startMonth - 1, 1));
  for (let count = 0; count < 24; count += 1) {
    const key = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`;
    output.push(key);
    if (key === endKey) return output;
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return [];
}

function hasExactCoverage(months, coverageByMonth, start, end) {
  return months.every((month, index) => {
    const coverage = coverageByMonth.get(month);
    if (!coverage || Number(coverage.cacheSchemaVersion) < CACHE_SCHEMA_VERSION) {
      return false;
    }
    const expectedStart = index === 0 ? start : `${month}-01`;
    const expectedEnd = index === months.length - 1 ? end : monthEnd(month);
    return coverage.rangeStart === expectedStart && coverage.rangeEnd === expectedEnd;
  });
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

function productFromDatabase(product) {
  return {
    productId: String(product.shopify_product_id || ""),
    recordKind: product.record_kind || "shopify",
    title: product.title || "",
    handle: product.handle || "",
    productType: product.product_type || "",
    status: product.status || "",
    imageUrl: product.image_url || "",
    createdAt: product.shopify_created_at || null,
    tags: product.tags || [],
    catalogState: product.catalog_state || "present",
  };
}

function productFromFile(product) {
  return {
    productId: String(product.shopifyProductId || ""),
    recordKind: product.recordKind || "shopify",
    title: product.title || "",
    handle: product.handle || "",
    productType: product.productType || "",
    status:
      product.catalogState === "missing"
        ? "MISSING"
        : product.catalogState === "deleted"
          ? "DELETED"
          : product.status || "",
    imageUrl: product.imageUrl || "",
    createdAt: product.createdAt || null,
    tags: product.tags || [],
    catalogState: product.catalogState || "present",
  };
}

function salesValues(metric, scale) {
  return {
    orders: Number(metric.product_orders) || 0,
    quantityOrdered: Number(metric.quantity_ordered) || 0,
    netItemsSold: Number(metric.net_items_sold) || 0,
    reversedQuantity: Number(metric.reversed_quantity) || 0,
    grossSales: (Number(metric.gross_sales_minor) || 0) / scale,
    discounts: (Number(metric.discounts_minor) || 0) / scale,
    salesReversals: (Number(metric.sales_reversals_minor) || 0) / scale,
    netSales: (Number(metric.net_sales_minor) || 0) / scale,
    shippingCharges: (Number(metric.shipping_charges_minor) || 0) / scale,
    returnFees: (Number(metric.return_fees_minor) || 0) / scale,
    taxes: (Number(metric.taxes_minor) || 0) / scale,
    totalSales: (Number(metric.total_sales_minor) || 0) / scale,
  };
}

function emptySales() {
  return {
    orders: 0,
    quantityOrdered: 0,
    netItemsSold: 0,
    reversedQuantity: 0,
    grossSales: 0,
    discounts: 0,
    salesReversals: 0,
    netSales: 0,
    shippingCharges: 0,
    returnFees: 0,
    taxes: 0,
    totalSales: 0,
  };
}

function addSales(left, right) {
  return Object.fromEntries(
    Object.keys(emptySales()).map((key) => [
      key,
      (Number(left?.[key]) || 0) + (Number(right?.[key]) || 0),
    ]),
  );
}

function createReport({
  source,
  products,
  productMetrics,
  storeMetrics,
  shopUrl,
  currency,
  refreshedAt,
}) {
  const productById = new Map(products.map((product) => [product.productId, product]));
  const seenProducts = new Set();
  let unattributedSales = emptySales();
  const cleanShopUrl = String(shopUrl || "").replace(/\/$/, "");
  const rows = productMetrics.map((metric) => {
    const metricProductId = String(metric.shopify_product_id || "");
    const isUnattributed =
      metric.record_kind === "unattributed" || metricProductId === "unattributed";
    const product = productById.get(metricProductId) || {
      productId: metricProductId,
      recordKind: isUnattributed ? "unattributed" : "shopify",
      title: isUnattributed
        ? "Unattributed Shopify Data"
        : `Unavailable product ${metricProductId}`,
      handle: "",
      productType: "Unknown",
      status: isUnattributed ? "UNATTRIBUTED" : "MISSING",
      tags: [],
      createdAt: null,
    };
    if (!isUnattributed) seenProducts.add(metricProductId);
    const rowCurrency = metric.currency_code || currency;
    const sales = salesValues(metric, currencyScale(rowCurrency));
    if (isUnattributed) unattributedSales = addSales(unattributedSales, sales);
    return {
      day: `${monthKey(metric.month)}-01`,
      productId: isUnattributed ? "UNATTRIBUTED" : metricProductId,
      title: product.title,
      status: product.status,
      productType: product.productType,
      tags: product.tags,
      handle: product.handle,
      imageUrl: product.imageUrl,
      productUrl:
        !isUnattributed && cleanShopUrl && product.handle
          ? `${cleanShopUrl}/products/${product.handle}`
          : "",
      createdAt: product.createdAt,
      firstDayInInventory: metric.first_day_in_inventory || null,
      startingInventory: metric.starting_inventory ?? null,
      endingInventory: metric.ending_inventory ?? null,
      landingSessions: isUnattributed
        ? null
        : Number(metric.landing_sessions) || 0,
      completedCheckoutSessions: isUnattributed
        ? null
        : Number(metric.completed_checkout_sessions) || 0,
      ...sales,
      ...(isUnattributed ? { isUnattributed: true } : {}),
    };
  });

  for (const product of products) {
    if (product.recordKind === "unattributed" || seenProducts.has(product.productId)) {
      continue;
    }
    rows.push({
      day: null,
      productId: product.productId,
      title: product.title,
      status: product.status,
      productType: product.productType,
      tags: product.tags,
      handle: product.handle,
      imageUrl: product.imageUrl,
      productUrl:
        cleanShopUrl && product.handle
          ? `${cleanShopUrl}/products/${product.handle}`
          : "",
      createdAt: product.createdAt,
      firstDayInInventory: null,
      startingInventory: null,
      endingInventory: null,
      landingSessions: 0,
      completedCheckoutSessions: 0,
      ...emptySales(),
    });
  }

  return {
    rows,
    shopCurrency: currency,
    productsError: null,
    analyticsErrors: [],
    shopifyqlDebug: null,
    unattributedSales,
    monthlyStoreSales: Object.fromEntries(
      storeMetrics.map((metric) => [
        monthKey(metric.month),
        (Number(metric.total_sales_minor) || 0) /
          currencyScale(metric.currency_code || currency),
      ]),
    ),
    uniqueOrderTotal: storeMetrics.reduce(
      (sum, metric) => sum + (Number(metric.unique_orders) || 0),
      0,
    ),
    catalogStatus: source,
    catalogRefreshedAt: refreshedAt || null,
    dataSource: source,
  };
}

async function loadDatabaseMonths(analytics, months, start, end, shopInfo) {
  const [result, directStoreMetrics] = await Promise.all([
    analytics.readProductAuditMonths(
      `${months[0]}-01`,
      `${months.at(-1)}-01`,
    ),
    analytics.selectStoreMonths({
      select: "month,total_sales_minor",
      filters: [
        ["month", "gte", `${months[0]}-01`],
        ["month", "lte", `${months.at(-1)}-01`],
      ],
      order: "month.asc",
    }),
  ]);
  const directStoreMetricsByMonth = new Map(
    directStoreMetrics.map((metric) => [monthKey(metric.month), metric]),
  );
  const storeMetrics = (result?.store_metrics || []).map((metric) => ({
    ...metric,
    ...directStoreMetricsByMonth.get(monthKey(metric.month)),
  }));
  const coverage = new Map(
    storeMetrics.map((metric) => [
      monthKey(metric.month),
      {
        rangeStart: metric.source_range_start,
        rangeEnd: metric.source_range_end,
        cacheSchemaVersion: metric.cache_schema_version,
      },
    ]),
  );
  if (!hasExactCoverage(months, coverage, start, end)) return null;
  const products = (result.products || []).map(productFromDatabase);
  return createReport({
    source: "supabase-database-monthly",
    products,
    productMetrics: result.product_metrics || [],
    storeMetrics,
    shopUrl: shopInfo.shopUrl,
    currency: storeMetrics[0]?.currency_code || shopInfo.shopCurrency,
    refreshedAt: storeMetrics.reduce(
      (latest, metric) =>
        !latest || metric.refreshed_at > latest ? metric.refreshed_at : latest,
      null,
    ),
  });
}

async function loadFileCacheMonths(analytics, months, start, end, shopInfo) {
  const [manifest, catalog] = await Promise.all([
    readAnalyticsManifest(analytics.store.id),
    readAnalyticsCatalog(analytics.store.id),
  ]);
  if (!manifest || !catalog) return null;
  const available = new Set((manifest.months || []).map((entry) => entry.month));
  if (months.some((month) => !available.has(month))) return null;
  const payloads = await Promise.all(
    months.map((month) => readAnalyticsMonth(analytics.store.id, month)),
  );
  const coverage = new Map(
    payloads.map((payload) => [
      payload.month,
      {
        rangeStart: payload.rangeStart,
        rangeEnd: payload.rangeEnd,
        cacheSchemaVersion: payload.cacheSchemaVersion,
      },
    ]),
  );
  if (!hasExactCoverage(months, coverage, start, end)) return null;
  const products = (catalog.products || []).map(productFromFile);
  return createReport({
    source: "supabase-storage-monthly",
    products,
    productMetrics: payloads.flatMap((payload) =>
      payload.productMetrics.map((metric) => ({
        ...metric,
        month: `${payload.month}-01`,
      })),
    ),
    storeMetrics: payloads.map((payload) => payload.storeMetrics),
    shopUrl: shopInfo.shopUrl,
    currency: payloads[0]?.currencyCode || shopInfo.shopCurrency,
    refreshedAt: manifest.generatedAt,
  });
}

export async function loadProductAuditMonthlyReport({
  session,
  start,
  end,
  shopInfo,
  analytics: providedAnalytics,
}) {
  const months = requestedMonths(start, end);
  if (!months.length) return null;
  const analytics =
    providedAnalytics || (await createAuthenticatedStoreAnalytics(session));
  if (!analytics) return null;
  const resolvedShopInfo = {
    shopUrl:
      shopInfo?.shopUrl ||
      (analytics.store.shop_domain
        ? `https://${analytics.store.shop_domain}`
        : ""),
    shopCurrency:
      shopInfo?.shopCurrency || analytics.store.currency_code || "USD",
  };
  if (analytics.store.storage_mode === "file_cache") {
    return loadFileCacheMonths(
      analytics,
      months,
      start,
      end,
      resolvedShopInfo,
    );
  }
  return loadDatabaseMonths(
    analytics,
    months,
    start,
    end,
    resolvedShopInfo,
  );
}

export const productAuditCacheSchemaVersion = CACHE_SCHEMA_VERSION;
