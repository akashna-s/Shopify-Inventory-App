import {
  deleteExpiredMonthlyMetrics,
  cleanupSupabaseOrphanProducts,
  deleteSupabaseRows,
  insertSupabaseRows,
  markSupabaseProductDeleted,
  reconcileSupabaseProductCatalog,
  reconcileSupabaseProductHandles,
  replaceSupabaseStoreMonth,
  selectSupabaseRows,
  updateSupabaseRows,
  upsertSupabaseRows,
} from "./supabase-analytics.server.js";

const TAG_DELETE_BATCH_SIZE = 500;

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
} = {}) {
  const shopDomain = authenticatedShop(session);
  let stores;
  if (createStore) {
    stores = await insertSupabaseRows("audit_stores", [{
      shop_domain: shopDomain,
      currency_code: currencyCode,
      status: "active",
      updated_at: new Date().toISOString(),
    }], { upsert: true, conflictColumns: ["shop_domain"] });
  } else {
    stores = await selectSupabaseRows("audit_stores", {
      select: "id,shop_domain,currency_code,status",
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

    async replaceProductTags(tags, refreshedProductIds) {
      const products = await selectSupabaseRows("audit_products", {
        select: "id",
        filters: [["store_id", "eq", storeId]],
      });
      const productIds = products.map((product) => String(product.id));
      const allowed = new Set(productIds);
      if (tags.some((tag) => !allowed.has(String(tag.product_id)))) {
        throw new Error("Every product tag must belong to the authenticated store.");
      }

      const refreshedIds = [...new Set((refreshedProductIds || []).map(String))];
      if (refreshedIds.some((id) => !allowed.has(id))) {
        throw new Error("Every refreshed product must belong to the authenticated store.");
      }
      for (let index = 0; index < refreshedIds.length; index += TAG_DELETE_BATCH_SIZE) {
        const ids = refreshedIds.slice(index, index + TAG_DELETE_BATCH_SIZE).join(",");
        await deleteSupabaseRows("audit_product_tags", [["product_id", "in", `(${ids})`]]);
      }
      return upsertSupabaseRows("audit_product_tags", tags, ["product_id", "tag"]);
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
      await deleteExpiredMonthlyMetrics(storeId, retainFromMonth);
      const graceBefore = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      return cleanupSupabaseOrphanProducts(storeId, graceBefore);
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
