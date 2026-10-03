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
const baseUrl = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!baseUrl || !serviceKey) throw new Error("Supabase server credentials are required.");
const headers = {
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
  "Content-Type": "application/json",
};

const storeResponse = await fetch(
  `${baseUrl}/rest/v1/audit_stores?select=id,storage_mode&order=id.asc&limit=1`,
  { headers },
);
if (!storeResponse.ok) throw new Error(`Could not read a verification store (${storeResponse.status}).`);
const store = (await storeResponse.json())[0];
if (!store) throw new Error("No analytics store exists for verification.");

const reportResponse = await fetch(
  `${baseUrl}/rest/v1/rpc/get_audit_product_month_report`,
  {
    method: "POST",
    headers,
    body: JSON.stringify({
      p_store_id: store.id,
      p_start_month: "2026-08-01",
      p_end_month: "2026-08-01",
    }),
  },
);
if (!reportResponse.ok) {
  throw new Error(`Product Audit monthly RPC failed (${reportResponse.status}): ${await reportResponse.text()}`);
}
const report = await reportResponse.json();
if (!Array.isArray(report.products) || !Array.isArray(report.product_metrics)) {
  throw new Error("Product Audit monthly RPC returned an invalid contract.");
}
console.log(
  `Product Audit monthly source verified for ${store.storage_mode} mode: ${report.products.length} products and ${report.product_metrics.length} monthly rows.`,
);
