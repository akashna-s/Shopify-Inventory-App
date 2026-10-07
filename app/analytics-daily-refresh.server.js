import { selectSupabaseRows } from "./supabase-analytics.server.js";
import { readAnalyticsManifest } from "./analytics-file-cache.server.js";
import {
  calendarDateInTimeZone,
  latestCompletedDate,
  normalizeIanaTimeZone,
} from "./store-calendar.server.js";

function localHour(instant, timeZone) {
  const value = new Intl.DateTimeFormat("en-US", {
    timeZone: normalizeIanaTimeZone(timeZone),
    hour: "2-digit",
    hourCycle: "h23",
  }).format(new Date(instant));
  return Number(value);
}

export function dailyRefreshDue({
  now,
  timeZone,
  refreshedAt,
  sourceRangeEnd,
  refreshHour = 5,
}) {
  const zone = normalizeIanaTimeZone(timeZone);
  if (localHour(now, zone) < refreshHour) return false;
  const today = calendarDateInTimeZone(now, zone);
  const expectedEnd = latestCompletedDate(now, zone);
  const refreshedToday = refreshedAt
    ? calendarDateInTimeZone(refreshedAt, zone) === today
    : false;
  return !refreshedToday || sourceRangeEnd !== expectedEnd;
}

export async function dueAnalyticsStores({ now = new Date() } = {}) {
  const configuredHour = Number(process.env.ANALYTICS_DAILY_REFRESH_HOUR);
  const refreshHour = Math.min(
    23,
    Math.max(0, Number.isFinite(configuredHour) ? configuredHour : 5),
  );
  const stores = await selectSupabaseRows("audit_stores", {
    select: "id,shop_domain,iana_timezone,storage_mode,status",
    filters: [["status", "eq", "active"]],
    order: "id.asc",
  });
  const due = [];
  for (const store of stores) {
    const timeZone = normalizeIanaTimeZone(store.iana_timezone);
    const month = latestCompletedDate(now, timeZone).slice(0, 7);
    let current = {};
    if (store.storage_mode === "database") {
      const rows = await selectSupabaseRows("audit_store_month_metrics", {
        select: "source_range_end,refreshed_at",
        filters: [
          ["store_id", "eq", store.id],
          ["month", "eq", `${month}-01`],
        ],
        limit: 1,
      });
      current = rows[0] || {};
    } else {
      const manifest = await readAnalyticsManifest(store.id).catch(() => null);
      const entry = (manifest?.months || []).find((item) => item.month === month);
      current = {
        refreshed_at: entry?.updatedAt || null,
        source_range_end: entry?.rangeEnd || null,
      };
    }
    if (dailyRefreshDue({
      now,
      timeZone,
      refreshedAt: current.refreshed_at,
      sourceRangeEnd: current.source_range_end,
      refreshHour,
    })) {
      due.push({ ...store, month });
    }
  }
  return due;
}
