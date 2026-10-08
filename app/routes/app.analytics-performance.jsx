import { authenticate } from "../shopify.server";
import { logAnalyticsPerformance } from "../analytics-performance.server.js";

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
  await authenticate.admin(request);
  const formData = await request.formData();
  logAnalyticsPerformance({
    phase: "browser_ready",
    status: "ok",
    requestKind: "initial",
    requestId: formData.get("requestId"),
    source: formData.get("source"),
    cacheStatus: formData.get("cacheStatus"),
    interval: formData.get("interval"),
    durationMs: formData.get("durationMs"),
    serverDurationMs: formData.get("serverDurationMs"),
    start: formData.get("start"),
    end: formData.get("end"),
  });
  return Response.json({ ok: true });
};
