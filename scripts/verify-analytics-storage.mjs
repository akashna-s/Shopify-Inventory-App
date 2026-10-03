import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

function parseEnvironment(source) {
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

parseEnvironment(await readFile(".env", "utf8"));
const {
  downloadAnalyticsObject,
  downloadAnalyticsObjectIfPresent,
  removeAnalyticsObjects,
  uploadAnalyticsObject,
} = await import("../app/supabase-storage.server.js");

const path = `verification/${randomUUID()}.json`;
const missingPath = `verification/${randomUUID()}.json`;
const expected = JSON.stringify({ verified: true });
try {
  const missing = await downloadAnalyticsObjectIfPresent(missingPath);
  if (missing !== null) throw new Error("A missing object did not return null.");
  await uploadAnalyticsObject(path, Buffer.from(expected), "application/json");
  const publicResponse = await fetch(
    `${String(process.env.SUPABASE_URL).replace(/\/$/, "")}/storage/v1/object/public/analytics-monthly-cache/${path}`,
  );
  if (publicResponse.ok) throw new Error("The analytics storage bucket is publicly readable.");
  const actual = (await downloadAnalyticsObject(path)).toString("utf8");
  if (actual !== expected) throw new Error("Downloaded verification content did not match.");
  console.log("Private analytics storage upload and authenticated download verified.");
} finally {
  await removeAnalyticsObjects([path]);
}
