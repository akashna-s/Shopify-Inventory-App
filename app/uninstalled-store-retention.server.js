import { removeAnalyticsStoreCache } from "./analytics-file-cache.server.js";
import {
  purgeSupabaseStoreIfExpired,
  selectSupabaseRows,
} from "./supabase-analytics.server.js";

export const DEFAULT_UNINSTALL_RETENTION_DAYS = 15;

function retentionDays(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1
    ? parsed
    : DEFAULT_UNINSTALL_RETENTION_DAYS;
}

export function uninstallRetentionCutoff(now, days = DEFAULT_UNINSTALL_RETENTION_DAYS) {
  const value = new Date(now);
  if (Number.isNaN(value.getTime())) throw new Error("A valid cleanup time is required.");
  value.setUTCDate(value.getUTCDate() - retentionDays(days));
  return value.toISOString();
}

export async function purgeExpiredUninstalledStores({
  now = new Date(),
  days = process.env.UNINSTALLED_STORE_RETENTION_DAYS,
  skippedStoreIds = [],
  listStores = selectSupabaseRows,
  removeFileCache = removeAnalyticsStoreCache,
  purgeStore = purgeSupabaseStoreIfExpired,
} = {}) {
  const resolvedDays = retentionDays(days);
  const skipped = new Set(skippedStoreIds.map(String));
  const stores = await listStores("audit_stores", {
    select: "id,shop_domain,storage_mode,uninstalled_at",
    filters: [
      ["status", "eq", "uninstalled"],
      ["uninstalled_at", "lte", uninstallRetentionCutoff(now, resolvedDays)],
    ],
    order: "id.asc",
  });
  const purged = [];
  const failures = [];

  for (const store of stores) {
    if (skipped.has(String(store.id))) continue;
    try {
      // File-cache objects live outside the relational cascade, so remove them
      // before the guarded database purge. A failure keeps the store row so the
      // next cleanup run can retry without losing track of the files.
      if (store.storage_mode === "file_cache") {
        await removeFileCache(store.id);
      }
      const result = await purgeStore(store.id, resolvedDays);
      if (result) {
        purged.push({
          storeId: String(store.id),
          shopDomain: store.shop_domain,
          storageMode: store.storage_mode,
        });
      }
    } catch (error) {
      failures.push({
        storeId: String(store.id),
        shopDomain: store.shop_domain,
        phase: "retention_cleanup",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { retentionDays: resolvedDays, purged, failures };
}
