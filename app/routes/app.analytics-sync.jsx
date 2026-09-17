import { authenticate } from "../shopify.server";
import {
  latestSupabaseSync,
  syncLatest18MonthsToSupabase,
} from "../shopify-supabase-sync.server";
import { isSupabaseAnalyticsConfigured } from "../supabase-analytics.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  if (!isSupabaseAnalyticsConfigured()) {
    return Response.json({ configured: false, job: null }, { status: 503 });
  }
  return Response.json({
    configured: true,
    job: await latestSupabaseSync(session.shop),
  });
};

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
  const { admin, session } = await authenticate.admin(request);
  if (!isSupabaseAnalyticsConfigured()) {
    return Response.json({ error: "Supabase analytics is not configured." }, { status: 503 });
  }
  try {
    const result = await syncLatest18MonthsToSupabase(admin, session);
    return Response.json(result, { status: result.status === "completed" ? 200 : 207 });
  } catch (error) {
    if (error.code === "SYNC_ALREADY_RUNNING") {
      return Response.json({ error: error.message }, { status: 409 });
    }
    return Response.json({ error: error.message || "Monthly analytics sync failed." }, { status: 500 });
  }
};
