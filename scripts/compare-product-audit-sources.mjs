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

const shopifyConfig = await readFile("shopify.app.toml", "utf8");
const configValue = (key) => shopifyConfig.match(
  new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m"),
)?.[1];
process.env.SHOPIFY_API_KEY ||= configValue("client_id");
process.env.SHOPIFY_APP_URL ||= configValue("application_url");
process.env.SCOPES ||= configValue("scopes");
if (!process.env.SHOPIFY_API_SECRET) {
  throw new Error(
    "SHOPIFY_API_SECRET is required to refresh the offline Shopify token before comparison. Run with the production app secret in the environment; it is never written to the report.",
  );
}

const [{ unauthenticated }, { shopifyIdText }, { runShopifyQL }] = await Promise.all([
  import("../app/shopify.server.js"),
  import("../app/shopify-id.js"),
  import("../app/shopifyql.server.js"),
]);

const baseUrl = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!baseUrl || !serviceKey) throw new Error("Supabase server credentials are required.");
const headers = {
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
  "Content-Type": "application/json",
};

async function supabase(path, options = {}) {
  const response = await fetch(`${baseUrl}/rest/v1/${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
  });
  if (!response.ok) {
    throw new Error(`Supabase request failed (${response.status}): ${await response.text()}`);
  }
  return response.json();
}

function currencyScale(currency) {
  try {
    return 10 ** new Intl.NumberFormat("en", {
      style: "currency",
      currency,
    }).resolvedOptions().maximumFractionDigits;
  } catch {
    return 100;
  }
}

function monthEnd(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  return `${month}-${String(new Date(year, monthNumber, 0).getDate()).padStart(2, "0")}`;
}

function handleFromPath(path) {
  const match = String(path || "").match(/\/products\/([^/?#]+)/);
  return match ? match[1] : null;
}

function number(value) {
  return Number(value) || 0;
}

const moneyFields = new Map([
  ["gross_sales", "gross_sales_minor"],
  ["discounts", "discounts_minor"],
  ["gross_sales_reversals", "sales_reversals_minor"],
  ["net_sales", "net_sales_minor"],
  ["shipping_charges", "shipping_charges_minor"],
  ["return_fees", "return_fees_minor"],
  ["taxes", "taxes_minor"],
  ["total_sales", "total_sales_minor"],
]);

const metricFields = [
  "first_day_in_inventory",
  "starting_inventory",
  "ending_inventory",
  "landing_sessions",
  "completed_checkout_sessions",
  "product_orders",
  "quantity_ordered",
  "net_items_sold",
  "reversed_quantity",
  ...moneyFields.values(),
];

function emptyMetric() {
  return Object.fromEntries(metricFields.map((field) => [field, field === "first_day_in_inventory" ? null : 0]));
}

function sourceKey(row) {
  return shopifyIdText(row.product_id) || "UNATTRIBUTED";
}

function mergeSourceRows(inventoryRows, salesRows, sessionRows, products, scale) {
  const output = new Map();
  const ensure = (key) => {
    if (!output.has(key)) output.set(key, emptyMetric());
    return output.get(key);
  };

  for (const row of inventoryRows) {
    const metric = ensure(sourceKey(row));
    const firstDay = row.first_day_in_inventory || null;
    if (firstDay && (!metric.first_day_in_inventory || firstDay < metric.first_day_in_inventory)) {
      metric.first_day_in_inventory = firstDay;
    }
    metric.starting_inventory = row.starting_inventory_units ?? null;
    metric.ending_inventory = row.ending_inventory_units ?? null;
  }

  for (const row of salesRows) {
    const metric = ensure(sourceKey(row));
    metric.product_orders += number(row.orders);
    metric.quantity_ordered += number(row.quantity_ordered);
    metric.net_items_sold += number(row.net_items_sold);
    metric.reversed_quantity += number(row.reversed_quantity);
    for (const [source, stored] of moneyFields) {
      metric[stored] += Math.round(number(row[source]) * scale);
    }
  }

  const idsByHandle = new Map();
  for (const product of products) {
    if (!product.handle || !product.shopify_product_id) continue;
    const existing = idsByHandle.get(product.handle);
    idsByHandle.set(
      product.handle,
      existing && existing !== product.shopify_product_id
        ? null
        : product.shopify_product_id,
    );
  }
  let unmatchedSessions = 0;
  for (const row of sessionRows) {
    const handle = handleFromPath(row.landing_page_path);
    const productId = handle ? idsByHandle.get(handle) : null;
    if (!productId) {
      unmatchedSessions += number(row.sessions);
      continue;
    }
    const metric = ensure(String(productId));
    metric.landing_sessions += number(row.sessions);
    metric.completed_checkout_sessions += number(row.sessions_that_completed_checkout);
  }
  return { metrics: output, unmatchedSessions };
}

function storedMetrics(rows) {
  return new Map(rows.map((row) => [
    row.record_kind === "unattributed" || !row.shopify_product_id
      ? "UNATTRIBUTED"
      : String(row.shopify_product_id),
    Object.fromEntries(metricFields.map((field) => [field, row[field] ?? (field === "first_day_in_inventory" ? null : 0)])),
  ]));
}

function normalized(field, value) {
  if (field === "first_day_in_inventory") return value ? String(value).slice(0, 10) : null;
  if (value === null || value === undefined) return null;
  return Number(value);
}

function compareMetricMaps(live, stored) {
  const differences = [];
  const keys = new Set([...live.keys(), ...stored.keys()]);
  for (const productId of keys) {
    const before = live.get(productId) || emptyMetric();
    const after = stored.get(productId) || emptyMetric();
    for (const field of metricFields) {
      const beforeValue = normalized(field, before[field]);
      const afterValue = normalized(field, after[field]);
      if (beforeValue !== afterValue) {
        differences.push({ productId, field, before: beforeValue, after: afterValue });
      }
    }
  }
  return { productsCompared: keys.size, valuesCompared: keys.size * metricFields.length, differences };
}

const [store] = await supabase(
  "audit_stores?select=id,shop_domain,currency_code,storage_mode&order=id.asc&limit=1",
);
if (!store) throw new Error("No analytics store exists for comparison.");
if (store.storage_mode !== "database") {
  throw new Error("This comparison command currently requires a database-mode verification store.");
}

const requestedMonths = process.argv.slice(2).filter((value) => /^\d{4}-\d{2}$/.test(value));
const coverage = await supabase(
  `audit_store_month_metrics?select=month,source_range_start,source_range_end,cache_schema_version&store_id=eq.${store.id}&cache_schema_version=gte.1&order=month.desc&limit=18`,
);
const completeMonths = coverage
  .filter((row) => {
    const month = String(row.month).slice(0, 7);
    return row.source_range_start === `${month}-01` && row.source_range_end === monthEnd(month);
  })
  .map((row) => String(row.month).slice(0, 7));
const months = (requestedMonths.length ? requestedMonths : completeMonths.slice(0, 3))
  .filter((month) => completeMonths.includes(month));
if (!months.length) {
  throw new Error(
    "No complete cache-schema-v1 month is available. Open the app and allow the automatic 18-month sync to finish, then run this comparison again.",
  );
}

const { admin } = await unauthenticated.admin(store.shop_domain);
let totalProducts = 0;
let totalValues = 0;
let totalDifferences = 0;
const allDifferences = [];

for (const month of months) {
  const start = `${month}-01`;
  const end = monthEnd(month);
  const [inventory, sales, sessions, orders, report] = await Promise.all([
    runShopifyQL(admin, `FROM inventory SHOW starting_inventory_units, ending_inventory_units, first_day_in_inventory GROUP BY product_id SINCE ${start} UNTIL ${end}`),
    runShopifyQL(admin, `FROM sales SHOW orders, quantity_ordered, net_items_sold, reversed_quantity, gross_sales, discounts, gross_sales_reversals, net_sales, shipping_charges, return_fees, taxes, total_sales GROUP BY product_id SINCE ${start} UNTIL ${end}`),
    runShopifyQL(admin, `FROM sessions SHOW sessions, sessions_that_completed_checkout WHERE landing_page_type = 'product' GROUP BY landing_page_path SINCE ${start} UNTIL ${end}`),
    runShopifyQL(admin, `FROM sales SHOW orders SINCE ${start} UNTIL ${end}`),
    supabase("rpc/get_audit_product_month_report", {
      method: "POST",
      body: JSON.stringify({
        p_store_id: store.id,
        p_start_month: start,
        p_end_month: start,
      }),
    }),
  ]);
  const failed = [inventory, sales, sessions, orders].find((result) => result.error || result.truncated);
  if (failed) throw new Error(`ShopifyQL validation failed for ${month}: ${failed.error || "result was truncated"}`);

  const scale = currencyScale(report.store_metrics?.[0]?.currency_code || store.currency_code);
  const live = mergeSourceRows(inventory.rows, sales.rows, sessions.rows, report.products || [], scale);
  const comparison = compareMetricMaps(live.metrics, storedMetrics(report.product_metrics || []));
  const liveUniqueOrders = number(orders.rows?.[0]?.orders);
  const storedUniqueOrders = number(report.store_metrics?.[0]?.unique_orders);
  if (liveUniqueOrders !== storedUniqueOrders) {
    comparison.differences.push({
      productId: "STORE_TOTAL",
      field: "unique_orders",
      before: liveUniqueOrders,
      after: storedUniqueOrders,
    });
    comparison.valuesCompared += 1;
  }
  totalProducts += comparison.productsCompared;
  totalValues += comparison.valuesCompared;
  totalDifferences += comparison.differences.length;
  allDifferences.push(...comparison.differences.map((difference) => ({ month, ...difference })));
  console.log(
    `${month}: ${comparison.productsCompared} product rows, ${comparison.valuesCompared} values, ${comparison.differences.length} mismatch(es), ${live.unmatchedSessions} unmatched live landing session(s).`,
  );
}

console.log(
  `Summary: ${months.length} month(s), ${totalProducts} product-month rows, ${totalValues} values, ${totalDifferences} mismatch(es).`,
);
if (allDifferences.length) {
  console.log("First mismatches:");
  for (const difference of allDifferences.slice(0, 20)) {
    console.log(
      `${difference.month} | ${difference.productId} | ${difference.field} | ShopifyQL=${difference.before} | saved=${difference.after}`,
    );
  }
  process.exitCode = 2;
}
