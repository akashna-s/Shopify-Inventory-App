import {
  readAnalyticsManifest,
  readAnalyticsMonth,
} from "../analytics-file-cache.server.js";
import { authenticate } from "../shopify.server";
import { createAuthenticatedStoreAnalytics } from "../store-analytics-access.server.js";

function publicManifest(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    storeId: manifest.storeId,
    currencyCode: manifest.currencyCode,
    ianaTimeZone: manifest.ianaTimeZone,
    generatedAt: manifest.generatedAt,
    catalog: manifest.catalog
      ? {
          checksum: manifest.catalog.checksum,
          compressedBytes: manifest.catalog.compressedBytes,
          updatedAt: manifest.catalog.updatedAt,
        }
      : null,
    months: (manifest.months || []).map((entry) => ({
      month: entry.month,
      checksum: entry.checksum,
      compressedBytes: entry.compressedBytes,
      productRows: entry.productRows,
      updatedAt: entry.updatedAt,
    })),
  };
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const analytics = await createAuthenticatedStoreAnalytics(session);
  if (!analytics) {
    return Response.json({ error: "Storage assignment not found." }, { status: 404 });
  }
  if (analytics.store.storage_mode !== "file_cache") {
    return Response.json(
      { error: "This store uses database analytics storage." },
      { status: 409 },
    );
  }

  const manifest = await readAnalyticsManifest(analytics.store.id);
  if (!manifest) {
    return Response.json(
      { error: "The monthly file cache has not been synchronized yet." },
      { status: 404 },
    );
  }

  const url = new URL(request.url);
  const month = url.searchParams.get("month");
  if (!month) {
    return Response.json(publicManifest(manifest), {
      headers: { "Cache-Control": "private, no-cache" },
    });
  }
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return Response.json({ error: "A valid YYYY-MM month is required." }, { status: 400 });
  }
  const entry = (manifest.months || []).find((item) => item.month === month);
  if (!entry) {
    return Response.json({ error: "That month is not available." }, { status: 404 });
  }

  const payload = await readAnalyticsMonth(analytics.store.id, month);
  return Response.json(payload, {
    headers: {
      "Cache-Control": "private, no-cache",
      ETag: `"${entry.checksum}"`,
    },
  });
};
