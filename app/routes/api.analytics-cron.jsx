import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import process from "node:process";

import { dueAnalyticsStores } from "../analytics-daily-refresh.server.js";
import { unauthenticated } from "../shopify.server";
import { syncLatest18MonthsToSupabase } from "../shopify-supabase-sync.server";

function authorized(request) {
  const configured = Buffer.from(String(process.env.ANALYTICS_CRON_SECRET || ""));
  const supplied = Buffer.from(
    String(request.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""),
  );
  return configured.length >= 24 &&
    configured.length === supplied.length &&
    timingSafeEqual(configured, supplied);
}

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
  if (!authorized(request)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  const now = new Date();
  const due = await dueAnalyticsStores({ now });
  const store = due[0];
  if (!store) {
    return Response.json({ processed: false, remainingDue: 0 });
  }

  try {
    const { admin, session } = await unauthenticated.admin(store.shop_domain);
    const result = await syncLatest18MonthsToSupabase(admin, session, {
      now,
      months: [store.month],
      preferCachedCatalog: false,
      jobType: "daily_current_month_refresh",
    });
    return Response.json({
      processed: true,
      status: result.status,
      month: store.month,
      storageMode: result.storageMode,
      remainingDue: Math.max(0, due.length - 1),
    }, { status: result.status === "completed" ? 200 : 207 });
  } catch (error) {
    console.error("Daily analytics refresh failed:", error.message);
    return Response.json(
      { error: error.message || "Daily analytics refresh failed." },
      { status: error.code === "SYNC_ALREADY_RUNNING" ? 409 : 500 },
    );
  }
};
