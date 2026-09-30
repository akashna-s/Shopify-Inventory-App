/* eslint-env node */

import assert from "node:assert/strict";
import test from "node:test";

import {
  addSyncProgress,
  createSyncProgress,
  shortErrorSummary,
  syncProgressFields,
} from "../app/sync-progress.server.js";

test("sync progress keeps job attempts, query retries and row operations separate", () => {
  const progress = createSyncProgress(2);
  addSyncProgress(progress, {
    queryRetryCount: 3,
    rowsProcessed: 100,
    rowsInserted: 60,
    rowsUpdated: 35,
    rowsDeleted: 5,
  });
  addSyncProgress(progress, {
    query_retry_count: 2,
    rows_processed: 10,
    rows_inserted: 4,
    rows_updated: 3,
    rows_deleted: 2,
  });

  assert.deepEqual(syncProgressFields(progress), {
    job_attempt: 2,
    query_retry_count: 5,
    rows_processed: 110,
    rows_inserted: 64,
    rows_updated: 38,
    rows_deleted: 7,
    attempts: 2,
    rows_written: 102,
  });
});

test("sync progress ignores invalid negative counts", () => {
  const progress = createSyncProgress();
  addSyncProgress(progress, {
    queryRetryCount: -1,
    rowsProcessed: "not-a-number",
    rowsInserted: -20,
  });

  assert.equal(progress.jobAttempt, 1);
  assert.equal(progress.queryRetryCount, 0);
  assert.equal(progress.rowsProcessed, 0);
  assert.equal(progress.rowsInserted, 0);
});

test("error summaries are single-line and bounded", () => {
  const summary = shortErrorSummary(new Error(`Failure\n${"x".repeat(600)}`), 80);
  assert.equal(summary.includes("\n"), false);
  assert.equal(summary.length, 80);
  assert.equal(summary.endsWith("..."), true);
});

test("sync progress migration adds independent counters and counted RPCs", async () => {
  const sql = await import("node:fs/promises").then((fs) => fs.readFile(
    new URL("../supabase/migrations/202609300005_sync_progress_metrics.sql", import.meta.url),
    "utf8",
  ));

  for (const column of [
    "job_attempt",
    "query_retry_count",
    "rows_processed",
    "rows_inserted",
    "rows_updated",
    "rows_deleted",
    "error_summary",
  ]) {
    assert.match(sql, new RegExp(`add column if not exists ${column}\\b`));
  }
  assert.match(sql, /replace_audit_store_month_with_counts/);
  assert.match(sql, /replace_audit_product_tags_with_counts/);
  assert.match(sql, /delete_expired_audit_monthly_metrics_with_counts/);
  assert.match(sql, /to service_role/);
  assert.match(sql, /from public, anon, authenticated/);
});
