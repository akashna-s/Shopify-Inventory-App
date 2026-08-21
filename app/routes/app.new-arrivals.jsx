import { useMemo, useState } from "react";
import { Form, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getProductCatalog } from "../product-catalog-cache.server";
import { runWithAnalyticsCache } from "../analytics-cache.server";
import { runShopifyQL } from "../shopifyql.server";
import { generateNewArrivalReport } from "../new-arrival-engine.server";
import styles from "../styles/new-arrivals.css?url";

/* Loader data and local table component props are runtime-validated by React Router. */
/* eslint-disable react/prop-types */

const PAGE_SIZE = 50;
const MATRIX_METRICS = [["naSkus", "NA SKUs", "number"], ["naSkuRate", "NA SKU %", "percent"], ["naSkuTotalRate", "NA SKU % (Total)", "percent"], ["naInventory", "NA Inventory", "number"], ["naInventoryRate", "NA Inventory %", "percent"], ["naSales", "NA Sales", "currency"], ["naSalesRate", "NA Sales %", "percent"], ["landingSessions", "Landing Sessions", "number"]];
const DETAIL_METRICS = [["startingInventory", "Starting inventory", "number"], ["endingInventory", "Ending inventory", "number"], ["sales", "Sales", "currency"], ["typeSalesRate", "Type sales %", "percent"], ["totalSalesRate", "Total sales %", "percent"], ["landingSessions", "Landing Sessions", "number"], ["orders", "Orders", "number"], ["conversionRate", "CR %", "percent"]];

const dateString = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const monthString = (date) => dateString(date).slice(0, 7);
function monthLabel(month) { const date = new Date(`${month}-01T00:00:00`); return date.toLocaleDateString("en-US", { month: "short", year: "2-digit" }).replace(" ", "-"); }
function shiftMonth(month, offset) { const [year, value] = month.split("-").map(Number); return monthString(new Date(year, value - 1 + offset, 1)); }
function monthsBetween(start, end) { const result = []; for (let value = start; value <= end; value = shiftMonth(value, 1)) result.push(value); return result; }
function monthBounds(month, yesterday) { const [year, value] = month.split("-").map(Number); const naturalEnd = dateString(new Date(year, value, 0)); return { start: `${month}-01`, end: naturalEnd > yesterday ? yesterday : naturalEnd }; }
const numericId = (value) => String(value ?? "").replace(/\D/g, "");
function numberFrom(row, key) { return Number(row?.[key]) || 0; }

function normalizeRange(url, now = new Date()) {
  const yesterdayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const yesterday = dateString(yesterdayDate);
  const currentMonth = monthString(yesterdayDate);
  const earliestMonth = shiftMonth(currentMonth, -17);
  const defaultStart = shiftMonth(currentMonth, -14);
  const valid = (value) => /^\d{4}-\d{2}$/.test(value || "");
  let startMonth = valid(url.searchParams.get("startMonth")) ? url.searchParams.get("startMonth") : defaultStart;
  let endMonth = valid(url.searchParams.get("endMonth")) ? url.searchParams.get("endMonth") : currentMonth;
  startMonth = startMonth < earliestMonth ? earliestMonth : startMonth > currentMonth ? currentMonth : startMonth;
  endMonth = endMonth > currentMonth ? currentMonth : endMonth < earliestMonth ? earliestMonth : endMonth;
  if (startMonth > endMonth) [startMonth, endMonth] = [endMonth, startMonth];
  return { startMonth, endMonth, earliestMonth, currentMonth, yesterday };
}

async function mapConcurrent(items, limit, worker) {
  const output = new Array(items.length); let next = 0;
  async function consume() { while (next < items.length) { const index = next++; output[index] = await worker(items[index]); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, consume));
  return output;
}

async function fetchProductsByIds(admin, productIds) {
  const batches = [];
  for (let index = 0; index < productIds.length; index += 250) batches.push(productIds.slice(index, index + 250));
  const results = await mapConcurrent(batches, 2, async (batch) => {
    const response = await admin.graphql(
      `#graphql
      query NewArrivalMissingProducts($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product { id title productType handle }
        }
      }`,
      { variables: { ids: batch.map((id) => `gid://shopify/Product/${id}`) } },
    );
    const json = await response.json();
    return (json.data?.nodes || []).filter(Boolean);
  });
  return results.flat();
}

async function fetchMonth(admin, shop, month, yesterday) {
  const { start, end } = monthBounds(month, yesterday);
  const cached = (dataset, query) => runWithAnalyticsCache({ shop, dataset: `new-arrival-${dataset}-${month}`, rangeStart: start, rangeEnd: end, run: () => runShopifyQL(admin, query) });
  const [inventory, sales, storeSales, landingSessions] = await Promise.all([
    cached("inventory-v2", `FROM inventory SHOW starting_inventory_units, ending_inventory_units GROUP BY product_id, product_title SINCE ${start} UNTIL ${end}`),
    cached("product-sales-v2", `FROM sales SHOW total_sales, orders GROUP BY product_id, product_title SINCE ${start} UNTIL ${end}`),
    cached("store-sales", `FROM sales SHOW total_sales SINCE ${start} UNTIL ${end}`),
    cached("landing-sessions", `FROM sessions SHOW sessions WHERE landing_page_type = 'product' GROUP BY landing_page_path SINCE ${start} UNTIL ${end}`),
  ]);
  return { month, inventory, sales, storeSales, landingSessions };
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const range = normalizeRange(new URL(request.url));
  const months = monthsBetween(range.startMonth, range.endMonth);
  const shopPromise = admin.graphql(
    `#graphql
    query NewArrivalShop {
      shop {
        currencyCode
        myshopifyDomain
        primaryDomain { url }
      }
    }`,
  ).then((response) => response.json()).then((json) => ({
    currency: json.data?.shop?.currencyCode || "USD",
    shopUrl: json.data?.shop?.primaryDomain?.url || "",
    storeHandle: String(json.data?.shop?.myshopifyDomain || "").replace(/\.myshopify\.com$/i, ""),
  }));
  const [catalog, shopInfo, monthly] = await Promise.all([getProductCatalog(admin, session.shop), shopPromise, mapConcurrent(months, 2, (month) => fetchMonth(admin, session.shop, month, range.yesterday))]);
  const catalogById = new Map(catalog.products.map((product) => [numericId(product.id), product]));
  const analyticsProductIds = new Set(monthly.flatMap((result) => [
    ...result.inventory.rows.map((row) => numericId(row.product_id)),
    ...result.sales.rows.map((row) => numericId(row.product_id)),
  ]).filter(Boolean));
  const missingIds = [...analyticsProductIds].filter((id) => !catalogById.has(id));
  if (missingIds.length) {
    const enrichedProducts = await fetchProductsByIds(admin, missingIds);
    for (const product of enrichedProducts) catalogById.set(numericId(product.id), product);
  }
  const productIdByHandle = new Map([...catalogById].map(([id, product]) => [product.handle, id]).filter(([handle]) => handle));
  const sourceRows = []; const monthlyStoreSales = {}; const warnings = []; const debug = [];
  for (const result of monthly) {
    const inventoryById = new Map(result.inventory.rows.map((row) => [numericId(row.product_id), row]));
    const salesById = new Map(result.sales.rows.map((row) => [numericId(row.product_id), row]));
    const sessionsById = new Map();
    for (const row of result.landingSessions.rows) {
      const match = String(row.landing_page_path || "").match(/\/products\/([^/?#]+)/);
      if (!match) continue;
      let handle = match[1];
      try { handle = decodeURIComponent(handle); } catch { /* Keep Shopify's original handle if malformed. */ }
      const productId = productIdByHandle.get(handle);
      if (productId) sessionsById.set(productId, (sessionsById.get(productId) || 0) + numberFrom(row, "sessions"));
    }
    for (const productId of new Set([...inventoryById.keys(), ...salesById.keys(), ...sessionsById.keys()])) {
      if (!productId) continue;
      const product = catalogById.get(productId) || {};
      const inventory = inventoryById.get(productId) || {};
      const sales = salesById.get(productId) || {};
      const storefrontUrl = product.handle && shopInfo.shopUrl ? `${shopInfo.shopUrl.replace(/\/$/, "")}/products/${product.handle}` : "";
      const adminUrl = shopInfo.storeHandle ? `https://admin.shopify.com/store/${shopInfo.storeHandle}/products/${productId}` : "";
      sourceRows.push({ productId, month: result.month, title: product.title || sales.product_title || inventory.product_title || `Product ${productId}`, productType: product.productType || "Others", productUrl: storefrontUrl || adminUrl, startingInventory: numberFrom(inventory, "starting_inventory_units"), endingInventory: numberFrom(inventory, "ending_inventory_units"), totalSales: numberFrom(sales, "total_sales"), orders: numberFrom(sales, "orders"), landingSessions: sessionsById.get(productId) || 0 });
    }
    monthlyStoreSales[result.month] = result.storeSales.rows.reduce((sum, row) => sum + numberFrom(row, "total_sales"), 0);
    for (const [label, query] of [["Inventory", result.inventory], ["Product sales", result.sales], ["Store sales", result.storeSales], ["Landing sessions", result.landingSessions]]) {
      if (query.error) warnings.push(`${result.month} ${label}: ${query.error}`);
      if (query.truncated) warnings.push(`${result.month} ${label}: reached the 100,000-row limit.`);
      debug.push({ month: result.month, label, rows: query.rows.length, cache: query.cacheStatus || "live", attempts: query.attempts || 1, time: query.elapsedMs || 0 });
    }
  }
  return { report: generateNewArrivalReport(sourceRows, months, monthlyStoreSales), currency: shopInfo.currency, range, warnings: [...new Set(warnings)], debug, catalogSource: catalog.source, catalogRefreshedAt: catalog.refreshedAt };
};

function display(value, type, currency) {
  if (type === "percent") return `${((value || 0) * 100).toFixed(1)}%`;
  if (type === "currency") return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).format(value || 0);
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(value || 0);
}

function Matrix({ title, matrix, months, currency, collapsible = false }) {
  const table = <div className="na-scroll"><table className="na-table"><thead><tr><th rowSpan="2" className="first">Cohort</th>{months.map((month) => <th key={month} colSpan={MATRIX_METRICS.length}>{monthLabel(month)}</th>)}</tr><tr>{months.flatMap((month) => MATRIX_METRICS.map(([, label]) => <th key={`${month}-${label}`}>{label}</th>))}</tr></thead><tbody>
    <tr className="summary"><th className="first">Grand Total</th>{months.flatMap((month) => MATRIX_METRICS.map(([key, , type]) => <td key={`${month}-${key}`}>{display(matrix.grand[month]?.[key], type, currency)}</td>))}</tr>
    {matrix.rows.map((row) => <tr key={row.cohort}><th className="first">{row.label}</th>{months.flatMap((month) => MATRIX_METRICS.map(([key, , type]) => <td key={`${month}-${key}`}>{row.values[month] ? display(row.values[month][key], type, currency) : "—"}</td>))}</tr>)}
  </tbody></table></div>;
  return collapsible ? <details className="na-card type-card"><summary>{title}</summary>{table}</details> : <section className="na-card"><h2>{title}</h2>{table}</section>;
}

function Details({ rows, months, currency }) {
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState({ month: "", key: "", direction: "asc" });
  const sortedRows = useMemo(() => {
    if (!sort.key) return rows;
    return [...rows].sort((a, b) => {
      const left = Number(a.values[sort.month]?.[sort.key]) || 0;
      const right = Number(b.values[sort.month]?.[sort.key]) || 0;
      return (left - right) * (sort.direction === "asc" ? 1 : -1) || a.productId.localeCompare(b.productId);
    });
  }, [rows, sort]);
  const toggleSort = (month, key) => {
    setSort((current) => ({ month, key, direction: current.month === month && current.key === key && current.direction === "asc" ? "desc" : "asc" }));
    setPage(1);
  };
  const pages = Math.max(1, Math.ceil(sortedRows.length / PAGE_SIZE)); const safePage = Math.min(page, pages); const visible = sortedRows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  return <section className="na-card"><div className="detail-bar"><h2>Cohort Details ({rows.length})</h2><div><button disabled={safePage === 1} onClick={() => setPage(safePage - 1)}>Previous</button><span>Page {safePage} of {pages}</span><button disabled={safePage === pages} onClick={() => setPage(safePage + 1)}>Next</button></div></div><div className="na-scroll detail-scroll"><table className="na-table detail"><thead><tr><th rowSpan="2">NA Cohort</th><th rowSpan="2">Product title</th><th rowSpan="2">Product ID</th><th rowSpan="2">Product type</th><th rowSpan="2">Product URL</th>{months.map((month) => <th key={month} colSpan={DETAIL_METRICS.length}>{monthLabel(month)}</th>)}</tr><tr>{months.flatMap((month) => DETAIL_METRICS.map(([key, label]) => <th key={`${month}-${label}`}><button className="sort-button" onClick={() => toggleSort(month, key)}>{label}<span>{sort.month === month && sort.key === key ? (sort.direction === "asc" ? "▲" : "▼") : "◇"}</span></button></th>))}</tr></thead><tbody>{visible.map((row) => <tr key={`${row.productId}-${row.productType}`}><td>{monthLabel(row.cohort)} NA</td><td title={row.title}>{row.title}</td><td>{row.productId}</td><td>{row.productType}</td><td>{row.productUrl ? <a href={row.productUrl} target="_blank" rel="noreferrer">View ↗</a> : "—"}</td>{months.flatMap((month) => DETAIL_METRICS.map(([key, , type]) => <td key={`${month}-${key}`}>{row.values[month] ? display(row.values[month][key], type, currency) : "—"}</td>))}</tr>)}</tbody></table></div></section>;
}

export default function NewArrivalAnalysisPage() {
  const { report, currency, range, warnings, debug, catalogSource, catalogRefreshedAt } = useLoaderData(); const [tab, setTab] = useState("analysis");
  return <s-page heading="New Arrival Analysis"><div className="na-page"><section className="na-card range"><Form method="get"><label>Start month<input type="month" name="startMonth" defaultValue={range.startMonth} min={range.earliestMonth} max={range.currentMonth} /></label><label>End month<input type="month" name="endMonth" defaultValue={range.endMonth} min={range.earliestMonth} max={range.currentMonth} /></label><button type="submit">Apply</button><div><strong>{monthLabel(range.startMonth)} – {monthLabel(range.endMonth)}</strong><small>Current month through {range.yesterday}. Last 18 calendar months available.</small></div></Form></section>
    {warnings.length > 0 && <section className="warning"><strong>Some data may be incomplete:</strong>{warnings.map((warning) => <div key={warning}>{warning}</div>)}</section>}
    <details className="debug"><summary>🔍 View fetch details</summary><p>Product catalog: {catalogSource} · refreshed {new Date(catalogRefreshedAt).toLocaleString()}</p>{debug.map((item) => <div key={`${item.month}-${item.label}`}>{item.month} · {item.label}: {item.rows} rows · {item.cache} · {item.attempts} attempt(s) · {item.time}ms</div>)}</details>
    <div className="tabs"><button className={tab === "analysis" ? "active" : ""} onClick={() => setTab("analysis")}>New Arrival Analysis</button><button className={tab === "details" ? "active" : ""} onClick={() => setTab("details")}>Cohort Details</button></div>
    {tab === "analysis" ? <><Matrix title="Overall" matrix={report.overall} months={report.months} currency={currency} />{report.byProductType.map(({ type, matrix }) => <Matrix key={type} title={type} matrix={matrix} months={report.months} currency={currency} collapsible />)}</> : <Details rows={report.details} months={report.months} currency={currency} />}
  </div></s-page>;
}

export const links = () => [{ rel: "stylesheet", href: styles }];
export const headers = (headersArgs) => boundary.headers(headersArgs);
