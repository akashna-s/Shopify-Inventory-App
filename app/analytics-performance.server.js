const ALLOWED_PHASES = new Set(["server_loader", "browser_ready"]);
const ALLOWED_REQUEST_KINDS = new Set([
  "initial",
  "category",
  "details",
  "export",
]);
const ALLOWED_INTERVALS = new Set(["month", "week"]);
const ALLOWED_STATUSES = new Set(["ok", "error"]);
const ALLOWED_SOURCES = new Set([
  "shopifyql",
  "supabase-database-new-arrival",
  "supabase-database-monthly",
  "supabase-storage-monthly",
  "unknown",
]);
const ALLOWED_CACHE_STATUSES = new Set([
  "memory",
  "database",
  "live",
  "unknown",
]);

function safeText(value, fallback = "unknown", maxLength = 64) {
  const text = String(value || "").trim();
  return (text || fallback).slice(0, maxLength);
}

function allowedText(value, allowed, fallback) {
  const text = safeText(value, fallback);
  return allowed.has(text) ? text : fallback;
}

function safeNumber(value, maximum = 3_600_000) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(maximum, Math.max(0, Math.round(number)));
}

function safeDate(value) {
  const text = safeText(value, "", 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : undefined;
}

export function analyticsResponseBytes(payload) {
  return new TextEncoder().encode(JSON.stringify(payload)).byteLength;
}

export function normalizeAnalyticsPerformanceEvent(values = {}) {
  const event = {
    event: "analytics_performance",
    report: "new_arrival",
    phase: allowedText(values.phase, ALLOWED_PHASES, "server_loader"),
    status: allowedText(values.status, ALLOWED_STATUSES, "ok"),
    requestKind: allowedText(
      values.requestKind,
      ALLOWED_REQUEST_KINDS,
      "initial",
    ),
    requestId: safeText(values.requestId, "unknown"),
    source: allowedText(values.source, ALLOWED_SOURCES, "unknown"),
    cacheStatus: allowedText(
      values.cacheStatus,
      ALLOWED_CACHE_STATUSES,
      "unknown",
    ),
    interval: allowedText(values.interval, ALLOWED_INTERVALS, "month"),
    durationMs: safeNumber(values.durationMs),
    sourceLoadMs: safeNumber(values.sourceLoadMs),
    reportBuildMs: safeNumber(values.reportBuildMs),
    serverDurationMs: safeNumber(values.serverDurationMs),
    responseBytes: safeNumber(values.responseBytes, 100_000_000),
    rowCount: safeNumber(values.rowCount, 10_000_000),
    recordedAt: new Date().toISOString(),
  };
  const start = safeDate(values.start);
  const end = safeDate(values.end);
  if (start) event.start = start;
  if (end) event.end = end;
  return event;
}

export function logAnalyticsPerformance(values) {
  const event = normalizeAnalyticsPerformanceEvent(values);
  const serialized = `[analytics-performance] ${JSON.stringify(event)}`;
  if (event.status === "error" || event.durationMs >= 5_000) {
    console.warn(serialized);
  } else {
    console.info(serialized);
  }
  return event;
}
