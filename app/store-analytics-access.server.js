import {
  deleteExpiredMonthlyMetrics,
  cleanupSupabaseOrphanProducts,
  ensureSupabaseUnattributedProduct,
  insertSupabaseRows,
  markSupabaseProductDeleted,
  reconcileSupabaseProductCatalog,
  reconcileSupabaseProductHandles,
  replaceSupabaseProductTags,
  replaceSupabaseStoreMonth,
  selectSupabaseRows,
  updateSupabaseRows,
  upsertSupabaseRows,
} from "./supabase-analytics.server.js";

function authenticatedShop(session) {
  const shop = String(session?.shop || "").trim().toLowerCase();
  if (!shop) throw new Error("An authenticated Shopify session is required for analytics access.");
  return shop;
}

function scopedOptions(storeId, options = {}) {
  return {
    ...options,
    filters: [
      ["store_id", "eq", storeId],
      ...(options.filters || []).filter(([column]) => column !== "store_id"),
    ],
  };
}

export async function createAuthenticatedStoreAnalytics(session, {
  createStore = false,
  currencyCode = "USD",
  ianaTimeZone = "Etc/UTC",
} = {}) {
  const shopDomain = authenticatedShop(session);
  let stores;
  if (createStore) {
    stores = await insertSupabaseRows("audit_stores", [{
      shop_domain: shopDomain,
      currency_code: currencyCode,
      iana_timezone: ianaTimeZone,
      status: "active",
      updated_at: new Date().toISOString(),
    }], { upsert: true, conflictColumns: ["shop_domain"] });
  } else {
    stores = await selectSupabaseRows("audit_stores", {
      select: "id,shop_domain,currency_code,iana_timezone,status",
      filters: [["shop_domain", "eq", shopDomain]],
      limit: 1,
    });
  }

  if (!stores.length) return null;
  const store = stores[0];
  const storeId = store.id;

  return {
    store,

    selectProducts(options = {}) {
      return selectSupabaseRows("audit_products", scopedOptions(storeId, options));
    },

    selectReportProducts(options = {}) {
      return selectSupabaseRows(
        "audit_products_with_effective_status",
        scopedOptions(storeId, options),
      );
    },

    upsertProducts(rows) {
      return upsertSupabaseRows(
        "audit_products",
        rows.map((row) => ({ ...row, store_id: storeId })),
        ["store_id", "shopify_product_id"],
      );
    },

    ensureUnattributedProduct() {
      return ensureSupabaseUnattributedProduct(storeId);
    },

    replaceProductTags(tags, refreshedProductIds) {
      return replaceSupabaseProductTags(storeId, refreshedProductIds || [], tags || []);
    },

    reconcileCatalog(shopifyProductIds, seenAt) {
      return reconcileSupabaseProductCatalog(storeId, shopifyProductIds, seenAt);
    },

    reconcileProductHandles(handles, seenAt) {
      return reconcileSupabaseProductHandles(storeId, handles, seenAt);
    },

    selectProductHandleHistory(options = {}) {
      return selectSupabaseRows(
        "audit_product_handle_history_with_product",
        scopedOptions(storeId, options),
      );
    },

    markProductDeleted(shopifyProductId, deletedAt = new Date().toISOString()) {
      return markSupabaseProductDeleted(storeId, shopifyProductId, deletedAt);
    },

    selectProductMonths(options = {}) {
      return selectSupabaseRows(
        "audit_product_month_metrics",
        scopedOptions(storeId, options),
      );
    },

    selectStoreMonths(options = {}) {
      return selectSupabaseRows(
        "audit_store_month_metrics",
        scopedOptions(storeId, options),
      );
    },

    replaceMonth({ month, productMetrics, storeMetrics }) {
      return replaceSupabaseStoreMonth({
        storeId,
        month,
        productMetrics,
        storeMetrics,
      });
    },

    async deleteExpiredMonths(retainFromMonth) {
      const monthlyCounts = await deleteExpiredMonthlyMetrics(storeId, retainFromMonth);
      const graceBefore = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const orphanProductsDeleted = Number(
        await cleanupSupabaseOrphanProducts(storeId, graceBefore),
      ) || 0;
      return {
        ...monthlyCounts,
        rowsDeleted: monthlyCounts.rowsDeleted + orphanProductsDeleted,
      };
    },

    createJob(values) {
      return insertSupabaseRows("audit_sync_jobs", [{ ...values, store_id: storeId }]);
    },

    selectJobs(options = {}) {
      return selectSupabaseRows("audit_sync_jobs", scopedOptions(storeId, options));
    },

    updateJob(jobId, values) {
      return updateSupabaseRows("audit_sync_jobs", values, [
        ["store_id", "eq", storeId],
        ["id", "eq", jobId],
      ]);
    },
  };
}
