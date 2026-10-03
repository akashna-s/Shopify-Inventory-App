import { authenticate } from "../shopify.server";
import { ensureShopifyStoreStorageAssignment } from "../shopify-storage-assignment.server.js";
import { isSupabaseAnalyticsConfigured } from "../supabase-analytics.server.js";

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
  const { admin, session } = await authenticate.admin(request);
  if (!isSupabaseAnalyticsConfigured()) {
    return Response.json(
      { error: "Supabase analytics is not configured." },
      { status: 503 },
    );
  }

  try {
    const assignment = await ensureShopifyStoreStorageAssignment(
      admin,
      session,
    );
    return Response.json({
      assigned: true,
      existingAssignment: assignment.existingAssignment,
      storageMode: assignment.store.storage_mode,
      projectedStorageBytes: Number(
        assignment.store.projected_storage_bytes,
      ),
    });
  } catch (error) {
    console.error("Analytics storage assignment failed:", error.message);
    return Response.json(
      { error: error.message || "Analytics storage assignment failed." },
      { status: 500 },
    );
  }
};
