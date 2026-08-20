import { useState } from "react";
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
const MATRIX_METRICS = [["naSkus", "NA SKUs", "number"], ["naSkuRate", "NA SKU %", "percent"], ["naSkuTotalRate", "NA SKU % (Total)", "percent"], ["naInventory", "NA Inventory", "number"], ["naInventoryRate", "NA Inventory %", "percent"], ["naSales", "NA Sales", "currency"], ["naSalesRate", "NA Sales %", "percent"]];
const DETAIL_METRICS = [["startingInventory", "Starting inventory", "number"], ["endingInventory", "Ending inventory", "number"], ["sales", "Sales", "currency"], ["typeSalesRate", "Type sales %", "percent"], ["totalSalesRate", "Total sales %", "percent"]];

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

async function fetchMonth(admin, shop, month, yesterday) {
  const { start, end } = monthBounds(month, yesterday);
  const cached = (dataset, query) => runWithAnalyticsCache({ shop, dataset: `new-arrival-${dataset}-${month}`, rangeStart: start, rangeEnd: end, run: () => runShopifyQL(admin, query) });
  const [inventory, sales, storeSales] = await Promise.all([
    cached("inventory", `FROM inventory SHOW starting_inventory_units, ending_inventory_units GROUP BY product_id SINCE ${start} UNTIL ${end}`),
    cached("product-sales", `FROM sales SHOW total_sales GROUP BY product_id SINCE ${start} UNTIL ${end}`),
    cached("store-sales", `FROM sales SHOW total_sales SINCE ${start} UNTIL ${end}`),
  ]);
  return { month, inventory, sales, storeSales };
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const range = normalizeRange(new URL(request.url));
  const months = monthsBetween(range.startMonth, range.endMonth);
  const currencyPromise = admin.graphql(
    `#graphql
    query NewArrivalShop {
      shop {
        currencyCode
      }
    }`,
  ).then((response) => response.json()).then((json) => json.data?.shop?.currencyCode || "USD");
  const [catalog, currency, monthly] = await Promise.all([getProductCatalog(admin, session.shop), currencyPromise, mapConcurrent(months, 2, (month) => fetchMonth(admin, session.shop, month, range.yesterday))]);
  const catalogById = new Map(catalog.products.map((product) => [numericId(product.id), product]));
  const sourceRows = []; const monthlyStoreSales = {}; const warnings = []; const debug = [];
  for (const result of monthly) {
    const inventoryById = new Map(result.inventory.rows.map((row) => [numericId(row.product_id), row]));
    const salesById = new Map(result.sales.rows.map((row) => [numericId(row.product_id), row]));
    for (const productId of new Set([...inventoryById.keys(), ...salesById.keys()])) {
      if (!productId) continue;
      const product = catalogById.get(productId) || {};
      sourceRows.push({ productId, month: result.month, title: product.title || `Product ${productId}`, productType: product.productType || "Others", startingInventory: numberFrom(inventoryById.get(productId), "starting_inventory_units"), endingInventory: numberFrom(inventoryById.get(productId), "ending_inventory_units"), totalSales: numberFrom(salesById.get(productId), "total_sales") });
    }
    monthlyStoreSales[result.month] = result.storeSales.rows.reduce((sum, row) => sum + numberFrom(row, "total_sales"), 0);
    for (const [label, query] of [["Inventory", result.inventory], ["Product sales", result.sales], ["Store sales", result.storeSales]]) {
      if (query.error) warnings.push(`${result.month} ${label}: ${query.error}`);
      if (query.truncated) warnings.push(`${result.month} ${label}: reached the 100,000-row limit.`);
      debug.push({ month: result.month, label, rows: query.rows.length, cache: query.cacheStatus || "live", attempts: query.attempts || 1, time: query.elapsedMs || 0 });
    }
  }
  return { report: generateNewArrivalReport(sourceRows, months, monthlyStoreSales), currency, range, warnings: [...new Set(warnings)], debug, catalogSource: catalog.source, catalogRefreshedAt: catalog.refreshedAt };
};

function display(value, type, currency) {
  if (type === "percent") return `${((value || 0) * 100).toFixed(1)}%`;
  if (type === "currency") return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).format(value || 0);
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(value || 0);
}

function Matrix({ title, matrix, months, currency, collapsible = false }) {
  const table = <div className="na-scroll"><table className="na-table"><thead><tr><th rowSpan="2" className="first">Cohort</th>{months.map((month) => <th key={month} colSpan={7}>{monthLabel(month)}</th>)}</tr><tr>{months.flatMap((month) => MATRIX_METRICS.map(([, label]) => <th key={`${month}-${label}`}>{label}</th>))}</tr></thead><tbody>
    <tr className="summary"><th className="first">Grand Total</th>{months.flatMap((month) => MATRIX_METRICS.map(([key, , type]) => <td key={`${month}-${key}`}>{display(matrix.grand[month]?.[key], type, currency)}</td>))}</tr>
    {matrix.rows.map((row) => <tr key={row.cohort}><th className="first">{row.label}</th>{months.flatMap((month) => MATRIX_METRICS.map(([key, , type]) => <td key={`${month}-${key}`}>{row.values[month] ? display(row.values[month][key], type, currency) : "—"}</td>))}</tr>)}
  </tbody></table></div>;
  return collapsible ? <details className="na-card type-card"><summary>{title}</summary>{table}</details> : <section className="na-card"><h2>{title}</h2>{table}</section>;
}

function Details({ rows, months, currency }) {
  const [page, setPage] = useState(1); const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE)); const safePage = Math.min(page, pages); const visible = rows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  return <section className="na-card"><div className="detail-bar"><h2>Cohort Details ({rows.length})</h2><div><button disabled={safePage === 1} onClick={() => setPage(safePage - 1)}>Previous</button><span>Page {safePage} of {pages}</span><button disabled={safePage === pages} onClick={() => setPage(safePage + 1)}>Next</button></div></div><div className="na-scroll"><table className="na-table detail"><thead><tr><th rowSpan="2">Launch month</th><th rowSpan="2">Product title</th><th rowSpan="2">Product ID</th><th rowSpan="2">Product type</th>{months.map((month) => <th key={month} colSpan={5}>{monthLabel(month)}</th>)}</tr><tr>{months.flatMap((month) => DETAIL_METRICS.map(([, label]) => <th key={`${month}-${label}`}>{label}</th>))}</tr></thead><tbody>{visible.map((row) => <tr key={`${row.productId}-${row.productType}`}><td>{monthLabel(row.cohort)}</td><td>{row.title}</td><td>{row.productId}</td><td>{row.productType}</td>{months.flatMap((month) => DETAIL_METRICS.map(([key, , type]) => <td key={`${month}-${key}`}>{row.values[month] ? display(row.values[month][key], type, currency) : "—"}</td>))}</tr>)}</tbody></table></div></section>;
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
