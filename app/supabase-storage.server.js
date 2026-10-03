const DEFAULT_BUCKET = "analytics-monthly-cache";

function storageConfig() {
  const url = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!url || !serviceRoleKey) {
    throw new Error(
      "Supabase storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the server.",
    );
  }
  return {
    url,
    serviceRoleKey,
    bucket: process.env.ANALYTICS_STORAGE_BUCKET || DEFAULT_BUCKET,
  };
}

function safeObjectPath(path) {
  const value = String(path || "").replace(/^\/+/, "");
  if (!value || value.includes("..") || value.includes("\\")) {
    throw new Error("A safe analytics storage object path is required.");
  }
  return value.split("/").map(encodeURIComponent).join("/");
}

async function storageRequest(path, options = {}) {
  const { url, serviceRoleKey } = storageConfig();
  const response = await fetch(`${url}/storage/v1/${path}`, {
    ...options,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      ...options.headers,
    },
  });
  if (!response.ok) {
    const message = await response.text();
    const error = new Error(
      `Supabase storage request failed (${response.status}): ${message}`,
    );
    error.status = response.status;
    error.storageMessage = message;
    throw error;
  }
  return response;
}

export function analyticsStorageBucket() {
  return storageConfig().bucket;
}

export function analyticsStorePrefix(storeId) {
  const id = String(storeId || "").trim();
  if (!/^\d+$/.test(id)) {
    throw new Error("A numeric internal store ID is required for analytics storage.");
  }
  return `stores/${id}`;
}

export async function uploadAnalyticsObject(
  objectPath,
  body,
  contentType = "application/gzip",
) {
  const { bucket } = storageConfig();
  const response = await storageRequest(
    `object/${encodeURIComponent(bucket)}/${safeObjectPath(objectPath)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": contentType,
        "x-upsert": "true",
        "Cache-Control": "no-cache",
      },
      body,
    },
  );
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

export async function downloadAnalyticsObject(objectPath) {
  const { bucket } = storageConfig();
  const response = await storageRequest(
    `object/authenticated/${encodeURIComponent(bucket)}/${safeObjectPath(objectPath)}`,
  );
  return Buffer.from(await response.arrayBuffer());
}

export async function downloadAnalyticsObjectIfPresent(objectPath) {
  try {
    return await downloadAnalyticsObject(objectPath);
  } catch (error) {
    if (
      error.status === 404 ||
      (error.status === 400 && /not found|does not exist/i.test(error.storageMessage))
    ) return null;
    throw error;
  }
}

export async function removeAnalyticsObjects(objectPaths) {
  if (!objectPaths.length) return;
  const { bucket } = storageConfig();
  await storageRequest(`object/${encodeURIComponent(bucket)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prefixes: objectPaths.map((path) => String(path)) }),
  });
}

export const analyticsStorageDefaults = Object.freeze({
  bucket: DEFAULT_BUCKET,
});
