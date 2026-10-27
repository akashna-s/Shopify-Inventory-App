import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import process from "node:process";

import { dueAnalyticsStores } from "../analytics-daily-refresh.server.js";
import {
  dailyRefreshFailure,
  refreshFirstDueAnalyticsStore,
} from "../analytics-cron.server.js";
import { unauthenticated } from "../shopify.server";
import { syncLatest18MonthsToSupabase } from "../shopify-supabase-sync.server";
import { purgeExpiredUninstalledStores } from "../uninstalled-store-retention.server.js";

function authorized(request) {
  const configured = Buffer.from(String(process.env.ANALYTICS_CRON_SECRET || ""));
  const supplied = Buffer.from(
    String(request.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""),
  );
  return configured.length >= 24 &&
    configured.length === supplied.length &&
    timingSafeEqual(configured, supplied);
}

function skippedStoreIds(request) {
  return String(request.headers.get("x-analytics-skip-store-ids") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function forceRefreshRequested(request) {
  return String(request.headers.get("x-analytics-force-refresh") || "")
    .trim()
    .toLowerCase() === "true";
}

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
  if (!authorized(request)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const now = new Date();
    const skipped = skippedStoreIds(request);
    const force = forceRefreshRequested(request);
    const retention = await purgeExpiredUninstalledStores({
      now,
      skippedStoreIds: skipped,
    });
    const due = await dueAnalyticsStores({ now, force });
    const outcome = await refreshFirstDueAnalyticsStore({
      dueStores: due,
      now,
      skippedStoreIds: skipped,
      authenticateStore: (store) => unauthenticated.admin(store.shop_domain),
      syncStore: (store, { admin, session }) =>
        syncLatest18MonthsToSupabase(admin, session, {
          now,
          months: [store.month],
          preferCachedCatalog: false,
          jobType: "daily_current_month_refresh",
        }),
    });
    const failures = [...retention.failures, ...outcome.failures];
    const response = { ...outcome, failures, retention };
    const hasFailures = failures.length > 0;
    return Response.json(response, {
      status: hasFailures || (outcome.processed && outcome.status !== "completed")
        ? 207
        : 200,
    });
  } catch (error) {
    const failure = dailyRefreshFailure(null, "store-discovery", error);
    console.error(`[analytics-daily-refresh] ${JSON.stringify(failure)}`);
    return Response.json({
      processed: false,
      remainingDue: 0,
      failures: [failure],
    }, { status: 500 });
  }
};
