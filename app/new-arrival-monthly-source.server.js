import { loadProductAuditMonthlyReport } from "./product-audit-monthly-source.server.js";

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

export async function loadNewArrivalMonthlySource({
  session,
  start,
  end,
  shopInfo,
}) {
  if (!/^\d{4}-\d{2}-01$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return null;
  }
  const lookback = newArrivalLookbackBounds(start);
  const report = await loadProductAuditMonthlyReport({
    session,
    start: lookback.start,
    end,
    shopInfo: {
      shopUrl: shopInfo.shopUrl,
      shopCurrency: shopInfo.currency,
    },
  });
  if (!report) return null;
  return newArrivalSourceFromMonthlyReport(report, {
    start,
    end,
    lookbackStart: lookback.start,
  });
}
