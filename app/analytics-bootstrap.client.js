const CACHE_SCHEMA_VERSION = 1;
const REQUIRED_MONTHS = 18;
const POLL_INTERVAL_MS = 5000;
const MAX_POLLS = 120;

const wait = (milliseconds) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

async function responseJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Analytics request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function syncStatus() {
  return responseJson(await fetch("/app/analytics-sync", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  }));
}

function initialSyncComplete(job) {
  const details = job?.details || {};
  return (
    job?.status === "completed" &&
    Number(details.cacheSchemaVersion) >= CACHE_SCHEMA_VERSION &&
    Number(details.totalMonths) >= REQUIRED_MONTHS &&
    (details.completedMonths || []).length >= REQUIRED_MONTHS
  );
}

async function waitForRunningSync(onStatus) {
  for (let poll = 0; poll < MAX_POLLS; poll += 1) {
    await wait(POLL_INTERVAL_MS);
    const status = await syncStatus();
    if (status.job?.status !== "running") return status.job;
    onStatus?.({ state: "syncing", message: "Preparing 18 months of analytics data…" });
  }
  throw new Error("The initial analytics sync is still running. It will continue in the background.");
}

async function startInitialSync(onStatus) {
  onStatus?.({ state: "syncing", message: "Preparing 18 months of analytics data…" });
  const response = await fetch("/app/analytics-sync", {
    method: "POST",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (response.status === 409) return waitForRunningSync(onStatus);
  return responseJson(response);
}

export async function bootstrapAnalyticsData({ storageMode, onStatus } = {}) {
  onStatus?.({ state: "checking", message: "Checking saved analytics data…" });
  let status = await syncStatus();
  if (status.job?.status === "running") {
    await waitForRunningSync(onStatus);
    status = await syncStatus();
  }
  if (!initialSyncComplete(status.job)) {
    await startInitialSync(onStatus);
  }

  if (storageMode === "file_cache") {
    onStatus?.({ state: "caching", message: "Saving monthly reports in this browser…" });
    const { refreshAnalyticsBrowserCache } = await import(
      "./analytics-browser-cache.client.js"
    );
    const result = await refreshAnalyticsBrowserCache();
    if (!result.ready) {
      throw new Error("Monthly files are not ready for browser caching yet.");
    }
  }

  onStatus?.({ state: "ready", message: "Saved analytics data is ready." });
  return { ready: true };
}
