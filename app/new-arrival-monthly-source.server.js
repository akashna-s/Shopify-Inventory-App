import { loadProductAuditMonthlyReport } from "./product-audit-monthly-source.server.js";
import { createAuthenticatedStoreAnalytics } from "./store-analytics-access.server.js";

const SOURCE_CACHE_TTL_MS = 5 * 60 * 1000;
const sourceCache = new Map();

function dateString(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function shiftMonth(month, offset) {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1 + offset, 1));
  return dateString(date).slice(0, 7);
}

export function newArrivalLookbackBounds(selectedStart) {
  const startMonth = String(selectedStart || "").slice(0, 7);
  const endDate = new Date(`${selectedStart}T00:00:00Z`);
  endDate.setUTCDate(endDate.getUTCDate() - 1);
  return {
    start: `${shiftMonth(startMonth, -2)}-01`,
    end: dateString(endDate),
  };
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function monthEnd(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  return dateString(new Date(Date.UTC(year, monthNumber, 0)));
}

function requestedMonths(start, end) {
  const output = [];
  for (
    let month = start.slice(0, 7);
    month <= end.slice(0, 7);
    month = shiftMonth(month, 1)
  ) {
    output.push(month);
  }
  return output;
}

function hasExactCoverage(storeMetrics, start, end) {
  const months = requestedMonths(start, end);
  const coverageByMonth = new Map(
    (storeMetrics || []).map((metric) => [
      String(metric.month || "").slice(0, 7),
      metric,
    ]),
  );
  return months.every((month, index) => {
    const coverage = coverageByMonth.get(month);
    if (!coverage || Number(coverage.cache_schema_version) < 1) return false;
    const expectedStart = index === 0 ? start : `${month}-01`;
    const expectedEnd =
      index === months.length - 1 ? end : monthEnd(month);
    return (
      coverage.source_range_start === expectedStart &&
      coverage.source_range_end === expectedEnd
    );
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

function activeInLookback(row) {
  return (
    !row.isUnattributed &&
    (number(row.startingInventory) > 0 ||
      number(row.endingInventory) > 0 ||
      number(row.totalSales) > 0)
  );
}

export function newArrivalSourceFromMonthlyReport(
  report,
  { start, end, lookbackStart },
) {
  const startMonth = start.slice(0, 7);
  const endMonth = end.slice(0, 7);
  const firstCohortProductIds = new Set();
  const sourceRows = [];

  for (const row of report.rows || []) {
    const period = String(row.day || "").slice(0, 7);
    if (!period) continue;
    if (period >= lookbackStart.slice(0, 7) && period < startMonth) {
      if (activeInLookback(row)) firstCohortProductIds.add(String(row.productId));
      continue;
    }
    if (period < startMonth || period > endMonth) continue;
    sourceRows.push({
      productId: row.productId,
      period,
      title: row.title,
      productType: row.productType,
      productTags: row.tags || [],
      productUrl: row.productUrl || "",
      handle: row.handle || "",
      imageUrl: row.imageUrl || "",
      startingInventory: row.startingInventory,
      endingInventory: row.endingInventory,
      totalSales: row.totalSales,
      orders: row.orders,
      landingSessions: row.landingSessions,
      ...(row.isUnattributed ? { isUnattributed: true } : {}),
    });
  }

  return {
    sourceRows,
    firstCohortProductIds,
    monthlyStoreSales: Object.fromEntries(
      Object.entries(report.monthlyStoreSales || {}).filter(
        ([month]) => month >= startMonth && month <= endMonth,
      ),
    ),
    currency: report.shopCurrency,
    dataSource: report.dataSource,
    refreshedAt: report.catalogRefreshedAt,
  };
}

export function newArrivalSourceFromDatabaseReport(
  report,
  { start, end, lookbackStart, shopInfo },
) {
  if (!report || !hasExactCoverage(report.store_metrics, lookbackStart, end)) {
    return null;
  }
  const productById = new Map(
    (report.products || []).map((product) => [
      String(product.shopify_product_id || ""),
      product,
    ]),
  );
  const cleanShopUrl = String(shopInfo.shopUrl || "").replace(/\/$/, "");
  const rows = (report.product_metrics || []).map((metric) => {
    const productId = String(metric.shopify_product_id || "");
    const product = productById.get(productId) || {};
    const isUnattributed =
      metric.record_kind === "unattributed" ||
      product.record_kind === "unattributed" ||
      productId === "unattributed";
    const currency = metric.currency_code || shopInfo.shopCurrency || "USD";
    const handle = metric.handle_snapshot || product.handle || "";
    return {
      day: `${String(metric.month).slice(0, 7)}-01`,
      productId: isUnattributed ? "UNATTRIBUTED" : productId,
      title: isUnattributed
        ? "Unattributed Shopify Data"
        : metric.title_snapshot || product.title || `Product ${productId}`,
      productType: isUnattributed
        ? "Unknown"
        : metric.product_type_snapshot || product.product_type || "Others",
      tags: isUnattributed ? [] : product.tags || [],
      handle,
      imageUrl: product.image_url || "",
      productUrl:
        !isUnattributed && cleanShopUrl && handle
          ? `${cleanShopUrl}/products/${handle}`
          : "",
      startingInventory: isUnattributed
        ? null
        : number(metric.starting_inventory),
      endingInventory: isUnattributed
        ? null
        : number(metric.ending_inventory),
      landingSessions: isUnattributed
        ? null
        : number(metric.landing_sessions),
      orders: isUnattributed ? null : number(metric.product_orders),
      totalSales:
        number(metric.total_sales_minor) / currencyScale(currency),
      ...(isUnattributed ? { isUnattributed: true } : {}),
    };
  });
  const storeMetrics = report.store_metrics || [];
  const monthlyStoreSales = Object.fromEntries(
    storeMetrics.map((metric) => {
      const currency = metric.currency_code || shopInfo.shopCurrency || "USD";
      return [
        String(metric.month).slice(0, 7),
        number(metric.total_sales_minor) / currencyScale(currency),
      ];
    }),
  );
  return newArrivalSourceFromMonthlyReport(
    {
      rows,
      monthlyStoreSales,
      shopCurrency:
        storeMetrics[0]?.currency_code || shopInfo.shopCurrency || "USD",
      dataSource: "supabase-database-new-arrival",
      catalogRefreshedAt: storeMetrics.reduce(
        (latest, metric) =>
          !latest || metric.refreshed_at > latest
            ? metric.refreshed_at
            : latest,
        null,
      ),
    },
    { start, end, lookbackStart },
  );
}

async function loadUncachedNewArrivalMonthlySource({
  session,
  start,
  end,
  shopInfo,
}) {
  const analytics = await createAuthenticatedStoreAnalytics(session);
  if (!analytics) return null;
  const resolvedShopInfo = {
    shopUrl:
      shopInfo?.shopUrl ||
      (analytics.store.shop_domain
        ? `https://${analytics.store.shop_domain}`
        : ""),
    shopCurrency:
      shopInfo?.currency || analytics.store.currency_code || "USD",
  };
  const lookback = newArrivalLookbackBounds(start);

  if (analytics.store.storage_mode !== "file_cache") {
    try {
      const compactReport = await analytics.readNewArrivalMonths(
        lookback.start,
        `${end.slice(0, 7)}-01`,
      );
      const compactSource = newArrivalSourceFromDatabaseReport(compactReport, {
        start,
        end,
        lookbackStart: lookback.start,
        shopInfo: resolvedShopInfo,
      });
      if (compactSource) return compactSource;
    } catch (error) {
      console.warn(
        "[New Arrival] Compact monthly read unavailable; using the compatible monthly read:",
        error.message,
      );
    }
  }

  const report = await loadProductAuditMonthlyReport({
    session,
    start: lookback.start,
    end,
    shopInfo: resolvedShopInfo,
    analytics,
  });
  if (!report) return null;
  return newArrivalSourceFromMonthlyReport(report, {
    start,
    end,
    lookbackStart: lookback.start,
  });
}

export async function loadNewArrivalMonthlySource({
  session,
  start,
  end,
  shopInfo,
}) {
  if (!/^\d{4}-\d{2}-01$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return null;
  }
  const shop = String(session?.shop || "").toLowerCase();
  const key = `${shop}|${start}|${end}`;
  const cached = sourceCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    const value = await cached.promise;
    return value ? { ...value, cacheStatus: "memory" } : null;
  }
  const promise = loadUncachedNewArrivalMonthlySource({
    session,
    start,
    end,
    shopInfo,
  });
  sourceCache.set(key, {
    expiresAt: Date.now() + SOURCE_CACHE_TTL_MS,
    promise,
  });
  while (sourceCache.size > 12) {
    sourceCache.delete(sourceCache.keys().next().value);
  }
  try {
    const value = await promise;
    return value ? { ...value, cacheStatus: "database" } : null;
  } catch (error) {
    sourceCache.delete(key);
    throw error;
  }
}
