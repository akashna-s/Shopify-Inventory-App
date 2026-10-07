import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";

import {
  analyticsStorePrefix,
  downloadAnalyticsObject,
  downloadAnalyticsObjectIfPresent,
  removeAnalyticsObjects,
  uploadAnalyticsObject,
} from "./supabase-storage.server.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const SCHEMA_VERSION = 1;

function jsonBuffer(value) {
  return Buffer.from(JSON.stringify(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function monthValue(month) {
  const value = String(month || "");
  if (!/^\d{4}-\d{2}$/.test(value)) {
    throw new Error("A YYYY-MM month is required for analytics file storage.");
  }
  return value;
}

export function analyticsFilePaths(storeId) {
  const prefix = analyticsStorePrefix(storeId);
  return {
    prefix,
    manifest: `${prefix}/manifest.json`,
    catalog: `${prefix}/catalog.json.gz`,
    month(month) {
      return `${prefix}/months/${monthValue(month)}.json.gz`;
    },
  };
}

async function compressJson(value) {
  return gzipAsync(jsonBuffer(value), { level: 9 });
}

async function parseCompressedJson(buffer) {
  return JSON.parse((await gunzipAsync(buffer)).toString("utf8"));
}

export async function readAnalyticsManifest(storeId) {
  const paths = analyticsFilePaths(storeId);
  const data = await downloadAnalyticsObjectIfPresent(paths.manifest);
  if (!data) return null;
  const manifest = JSON.parse(data.toString("utf8"));
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `Unsupported analytics file schema version ${manifest.schemaVersion}.`,
    );
  }
  return manifest;
}

export async function writeAnalyticsManifest(storeId, manifest) {
  const paths = analyticsFilePaths(storeId);
  const value = {
    ...manifest,
    schemaVersion: SCHEMA_VERSION,
    storeId: String(storeId),
  };
  await uploadAnalyticsObject(
    paths.manifest,
    jsonBuffer(value),
    "application/json",
  );
  return value;
}

export async function readAnalyticsCatalog(storeId) {
  const paths = analyticsFilePaths(storeId);
  const data = await downloadAnalyticsObjectIfPresent(paths.catalog);
  return data ? parseCompressedJson(data) : null;
}

export async function writeAnalyticsCatalog(storeId, catalog) {
  const paths = analyticsFilePaths(storeId);
  const compressed = await compressJson({
    ...catalog,
    schemaVersion: SCHEMA_VERSION,
    storeId: String(storeId),
  });
  await uploadAnalyticsObject(paths.catalog, compressed);
  return {
    path: paths.catalog,
    checksum: sha256(compressed),
    compressedBytes: compressed.length,
    updatedAt: new Date().toISOString(),
  };
}

export async function readAnalyticsMonth(storeId, month) {
  const paths = analyticsFilePaths(storeId);
  const data = await downloadAnalyticsObject(paths.month(month));
  const payload = await parseCompressedJson(data);
  if (payload.storeId !== String(storeId) || payload.month !== monthValue(month)) {
    throw new Error("Analytics month file identity does not match the authenticated store.");
  }
  return payload;
}

export async function writeAnalyticsMonth(storeId, month, payload) {
  const normalizedMonth = monthValue(month);
  const paths = analyticsFilePaths(storeId);
  const value = {
    ...payload,
    schemaVersion: SCHEMA_VERSION,
    storeId: String(storeId),
    month: normalizedMonth,
  };
  const compressed = await compressJson(value);
  const path = paths.month(normalizedMonth);
  await uploadAnalyticsObject(path, compressed);
  return {
    month: normalizedMonth,
    path,
    checksum: sha256(compressed),
    compressedBytes: compressed.length,
    productRows: Array.isArray(value.productMetrics)
      ? value.productMetrics.length
      : 0,
    rangeStart: value.rangeStart || null,
    rangeEnd: value.rangeEnd || null,
    cacheSchemaVersion: Number(value.cacheSchemaVersion) || SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
  };
}

export async function removeAnalyticsMonths(storeId, months) {
  const paths = analyticsFilePaths(storeId);
  const normalized = [...new Set(months.map(monthValue))];
  await removeAnalyticsObjects(normalized.map((month) => paths.month(month)));
}

export async function pruneAnalyticsFileMonths(storeId, retainedMonths) {
  const manifest = await readAnalyticsManifest(storeId);
  if (!manifest) return { removedMonths: [], rowsDeleted: 0 };
  const retained = new Set(retainedMonths.map(monthValue));
  const expired = (manifest.months || []).filter(
    (entry) => !retained.has(entry.month),
  );
  if (!expired.length) return { removedMonths: [], rowsDeleted: 0 };
  await removeAnalyticsMonths(storeId, expired.map((entry) => entry.month));
  await writeAnalyticsManifest(storeId, {
    ...manifest,
    generatedAt: new Date().toISOString(),
    months: (manifest.months || []).filter((entry) => retained.has(entry.month)),
  });
  return {
    removedMonths: expired.map((entry) => entry.month),
    rowsDeleted: expired.reduce(
      (sum, entry) => sum + (Number(entry.productRows) || 0),
      0,
    ),
  };
}

export const analyticsFileSchemaVersion = SCHEMA_VERSION;
