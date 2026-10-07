const POLL_INTERVAL_MS = 5000;
const STEP_PAUSE_MS = 1500;
const REPORT_READY_TIMEOUT_MS = 30000;
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

function progressStatus(preparation) {
  const completed = Number(preparation?.completedCount) || 0;
  const required = Number(preparation?.requiredCount) || 18;
  return {
    state: "syncing",
    message: `Preparing saved analytics: ${completed} of ${required} months ready…`,
  };
}

async function waitForRunningSync(onStatus) {
  for (let poll = 0; poll < MAX_POLLS; poll += 1) {
    await wait(POLL_INTERVAL_MS);
    const status = await syncStatus();
    if (status.job?.status !== "running") return status;
    onStatus?.(progressStatus(status.preparation));
  }
  throw new Error("The analytics step is taking longer than expected.");
}

async function waitForVisibleReport() {
  const reportPage = /^\/app\/(products|new-arrivals)/.test(window.location.pathname);
  if (!reportPage || window.__analyticsReportReady) {
    await wait(1200);
    return;
  }
  await Promise.race([
    new Promise((resolve) =>
      window.addEventListener("analytics-report-ready", resolve, { once: true }),
    ),
    wait(REPORT_READY_TIMEOUT_MS),
  ]);
}

async function waitForInteractiveReportIdle() {
  while (window.__analyticsInteractiveReportBusy) await wait(750);
}

async function runOneStep(onStatus) {
  await waitForInteractiveReportIdle();
  const response = await fetch("/app/analytics-sync", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ mode: "step" }),
  });
  if (response.status === 409) return waitForRunningSync(onStatus);
  const result = await responseJson(response);
  if (result.status && result.status !== "completed") {
    throw new Error(
      result.failedMonths?.[0]?.error || "One monthly analytics step failed.",
    );
  }
  return result;
}

export async function bootstrapAnalyticsData({ storageMode, onStatus } = {}) {
  onStatus?.({ state: "checking", message: "Checking saved analytics data…" });
  let status = await syncStatus();
  if (!status.preparation) {
    throw new Error("The analytics storage assignment is not ready yet.");
  }
  if (status.job?.status === "running") {
    status = await waitForRunningSync(onStatus);
  }

  await waitForVisibleReport();
  while (!status.preparation?.ready) {
    onStatus?.(progressStatus(status.preparation));
    await runOneStep(onStatus);
    status = await syncStatus();
    if (!status.preparation?.ready) await wait(STEP_PAUSE_MS);
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
