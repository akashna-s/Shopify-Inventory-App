/* eslint-env node */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_UNINSTALL_RETENTION_DAYS,
  purgeExpiredUninstalledStores,
  uninstallRetentionCutoff,
} from "../app/uninstalled-store-retention.server.js";

test("uninstalled-store retention defaults to 15 complete days", () => {
  assert.equal(DEFAULT_UNINSTALL_RETENTION_DAYS, 15);
  assert.equal(
    uninstallRetentionCutoff("2026-10-20T10:30:00.000Z"),
    "2026-10-05T10:30:00.000Z",
  );
});

test("database stores are purged without file-cache deletion", async () => {
  const calls = [];
  const result = await purgeExpiredUninstalledStores({
    now: new Date("2026-10-20T10:30:00.000Z"),
    listStores: async (_table, options) => {
      calls.push(options);
      return [{
        id: 3,
        shop_domain: "store.myshopify.com",
        storage_mode: "database",
        uninstalled_at: "2026-10-01T00:00:00.000Z",
      }];
    },
    removeFileCache: async () => assert.fail("database store has no file cache"),
    purgeStore: async (storeId, days) => {
      assert.equal(storeId, 3);
      assert.equal(days, 15);
      return { store_id: 3 };
    },
  });

  assert.deepEqual(calls[0].filters, [
    ["status", "eq", "uninstalled"],
    ["uninstalled_at", "lte", "2026-10-05T10:30:00.000Z"],
  ]);
  assert.equal(result.purged.length, 1);
  assert.deepEqual(result.failures, []);
});

test("file-cache deletion completes before the guarded database purge", async () => {
  const order = [];
  const result = await purgeExpiredUninstalledStores({
    listStores: async () => [{
      id: 9,
      shop_domain: "file-store.myshopify.com",
      storage_mode: "file_cache",
      uninstalled_at: "2026-09-01T00:00:00.000Z",
    }],
    removeFileCache: async (storeId) => order.push(`files:${storeId}`),
    purgeStore: async (storeId) => {
      order.push(`database:${storeId}`);
      return { store_id: storeId };
    },
  });

  assert.deepEqual(order, ["files:9", "database:9"]);
  assert.equal(result.purged[0].storageMode, "file_cache");
});

test("a file-cache failure keeps the database row available for retry", async () => {
  let databasePurged = false;
  const result = await purgeExpiredUninstalledStores({
    listStores: async () => [{
      id: 10,
      shop_domain: "retry.myshopify.com",
      storage_mode: "file_cache",
      uninstalled_at: "2026-09-01T00:00:00.000Z",
    }],
    removeFileCache: async () => {
      throw new Error("storage unavailable");
    },
    purgeStore: async () => {
      databasePurged = true;
    },
  });

  assert.equal(databasePurged, false);
  assert.equal(result.purged.length, 0);
  assert.equal(result.failures[0].phase, "retention_cleanup");
  assert.match(result.failures[0].error, /storage unavailable/);
});

test("retention migration performs a guarded cascade purge", async () => {
  const migration = await readFile(
    new URL("../supabase/migrations/202610140001_uninstalled_store_retention.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /status = 'uninstalled'/);
  assert.match(migration, /uninstalled_at <= now\(\) - make_interval/);
  assert.match(migration, /delete from public\.audit_shopify_sessions/);
  assert.match(migration, /delete from public\.audit_stores/);
  assert.match(migration, /grant execute.*purge_audit_store_if_expired/s);
});
