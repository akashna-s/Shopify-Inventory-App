import { projectedStoreStorageBytes } from "./analytics-storage-routing.server.js";
import { refreshProductCatalog } from "./product-catalog-cache.server.js";
import { createAuthenticatedStoreAnalytics } from "./store-analytics-access.server.js";
import { normalizeIanaTimeZone } from "./store-calendar.server.js";

async function fetchShopStorageInfo(admin) {
  const response = await admin.graphql(`#graphql
    query AnalyticsStorageAssignmentShop {
      shop { currencyCode ianaTimezone }
    }
  `);
  const json = await response.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return {
    currencyCode: json.data?.shop?.currencyCode || "USD",
    ianaTimeZone: normalizeIanaTimeZone(json.data?.shop?.ianaTimezone),
  };
}

export async function ensureShopifyStoreStorageAssignment(admin, session) {
  const existing = await createAuthenticatedStoreAnalytics(session);
  if (existing) {
    return { store: existing.store, existingAssignment: true };
  }

  const [shop, catalog] = await Promise.all([
    fetchShopStorageInfo(admin),
    refreshProductCatalog(admin, session.shop),
  ]);
  const analytics = await createAuthenticatedStoreAnalytics(session, {
    createStore: true,
    currencyCode: shop.currencyCode,
    ianaTimeZone: shop.ianaTimeZone,
    projectedStorageBytes: projectedStoreStorageBytes(catalog.products.length),
  });
  return { store: analytics.store, existingAssignment: false };
}
