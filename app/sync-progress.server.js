const COUNT_KEYS = [
  "queryRetryCount",
  "rowsProcessed",
  "rowsInserted",
  "rowsUpdated",
  "rowsDeleted",
];

function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

export function createSyncProgress(jobAttempt = 1) {
  return {
    jobAttempt: Math.max(1, nonNegativeInteger(jobAttempt)),
    queryRetryCount: 0,
    rowsProcessed: 0,
    rowsInserted: 0,
    rowsUpdated: 0,
    rowsDeleted: 0,
  };
}

export function addSyncProgress(progress, counts = {}) {
  for (const key of COUNT_KEYS) {
    const snakeKey = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    progress[key] += nonNegativeInteger(counts[key] ?? counts[snakeKey]);
  }
  return progress;
}

export function syncProgressFields(progress) {
  const rowsWritten = progress.rowsInserted + progress.rowsUpdated;
  return {
    job_attempt: progress.jobAttempt,
    query_retry_count: progress.queryRetryCount,
    rows_processed: progress.rowsProcessed,
    rows_inserted: progress.rowsInserted,
    rows_updated: progress.rowsUpdated,
    rows_deleted: progress.rowsDeleted,
    // Legacy fields remain populated so older operational views do not break.
    attempts: progress.jobAttempt,
    rows_written: rowsWritten,
  };
}

export function shortErrorSummary(error, maximumLength = 500) {
  const message = String(error?.message || error || "Sync failed.")
    .replace(/\s+/g, " ")
    .trim();
  if (message.length <= maximumLength) return message;
  return `${message.slice(0, Math.max(0, maximumLength - 3)).trimEnd()}...`;
}
