import { Suspense, useMemo, useState } from "react";
import { Await, useLoaderData, useNavigation, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getProductCatalog } from "../product-catalog-cache.server";
import { runWithAnalyticsCache } from "../analytics-cache.server";

/* Loader and Await render props are runtime-validated by React Router. */
/* eslint-disable react/prop-types */

// Strips a GraphQL GID (or any string) down to its trailing numeric id so it
// can be matched against the ids ShopifyQL returns, whatever shape those take.
function numericId(value) {
    if (value === null || value === undefined) return "";
    return String(value).replace(/\D/g, "");
}

// ── Date helpers for day / week / month filtering ──
function fmtDate(d) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
}

function monthBounds(monthStr) {
    const [year, month] = monthStr.split("-").map(Number);
    const lastDay = new Date(year, month, 0).getDate();
    return {
        start: `${monthStr}-01`,
        end: `${monthStr}-${String(lastDay).padStart(2, "0")}`,
    };
}

function weekBounds(dateStr) {
    const d = new Date(dateStr + "T00:00:00");
    const day = d.getDay();
    const diffToMonday = day === 0 ? -6 : 1 - day;
    const monday = new Date(d);
    monday.setDate(d.getDate() + diffToMonday);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    return { start: fmtDate(monday), end: fmtDate(sunday) };
}

function dayBounds(dateStr) {
    return { start: dateStr, end: dateStr };
}

function dateBoundsFor(filterType, dateParam) {
    if (filterType === "day") return dayBounds(dateParam);
    if (filterType === "week") return weekBounds(dateParam);
    return monthBounds(dateParam);
}

function adjustMonth(monthStr, deltaMonths) {
    if (!monthStr || !/^\d{4}-\d{2}$/.test(monthStr)) return monthStr;
    const [year, month] = monthStr.split("-").map(Number);
    const date = new Date(year, month - 1 + deltaMonths, 1);
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    return `${yyyy}-${mm}`;
}

function adjustDay(dateStr, deltaDays) {
    const d = new Date(dateStr + "T00:00:00");
    d.setDate(d.getDate() + deltaDays);
    return fmtDate(d);
}

function adjustWeek(dateStr, deltaWeeks) {
    return adjustDay(dateStr, deltaWeeks * 7);
}

function humanRange(filterType, start, end) {
    const opts = { month: "short", day: "numeric", year: "numeric" };
    const s = new Date(start + "T00:00:00");
    if (filterType === "day") return s.toLocaleDateString("en-US", { weekday: "short", ...opts });
    // Week and month both spell out the exact span they cover, so it is always
    // clear which days the figures below are drawn from.
    const e = new Date(end + "T00:00:00");
    return `${s.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${e.toLocaleDateString("en-US", opts)}`;
}

// Runs a ShopifyQL query and normalizes the response into rows of
// { columnName: value }. Never throws — callers get an `error` string
// instead so one failing analytics query can't take down the whole page.
function extractRequestId(response, json) {
    const checkObj = (obj) => {
        if (!obj) return null;
        if (typeof obj.get === "function") {
            const val = obj.get("x-request-id") || obj.get("X-Request-Id") || obj.get("X-REQUEST-ID");
            if (val) return val;
        }
        for (const [key, value] of Object.entries(obj)) {
            if (key.toLowerCase() === "x-request-id") {
                return Array.isArray(value) ? value[0] : value;
            }
        }
        return null;
    };
    return checkObj(response?.headers) || checkObj(json?.headers) || null;
}

// ShopifyQL silently caps a result set at 1000 rows when the query carries no
// LIMIT clause, and it returns the highest-value rows first. On a store with
// more than 1000 products (or more than 1000 landing pages) that quietly drops
// the long tail, so low-selling products report ₹0 sales / 0 sessions even
// though they did sell. Always send an explicit LIMIT. The server rejects
// values above its own ceiling, so keep this comfortably under it.
const SHOPIFYQL_ROW_LIMIT = 100000;
const SHOPIFYQL_MAX_ATTEMPTS = 3;
const SHOPIFYQL_RETRY_BASE_MS = 750;
const PRODUCT_PAGE_SIZE = 50;
const STATUS_COLORS = {
    ACTIVE: { bg: "#e3f1df", fg: "#0d5e27" },
    DRAFT: { bg: "#fff4e5", fg: "#9c5b00" },
    ARCHIVED: { bg: "#e4e5e7", fg: "#4a4a4a" },
};

// Kept temporarily for backward-compatible bookmarked URLs while the report
// moves fully to custom ranges; explicit references avoid dead-code warnings.
void dateBoundsFor;
void adjustMonth;
void adjustWeek;
void humanRange;
void STATUS_COLORS;

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function earliestReportDate(now = new Date()) {
    return fmtDate(new Date(now.getFullYear(), now.getMonth() - 18, 1));
}

function normalizeCustomRange(url, now = new Date()) {
    const earliest = earliestReportDate(now);
    const today = fmtDate(now);
    const defaultStart = fmtDate(new Date(now.getFullYear(), now.getMonth(), 1));
    const requestedStart = url.searchParams.get("start") || defaultStart;
    const requestedEnd = url.searchParams.get("end") || today;
    const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value);
    const start = validDate(requestedStart) ? requestedStart : defaultStart;
    const end = validDate(requestedEnd) ? requestedEnd : today;
    const boundedStart = start < earliest ? earliest : start > today ? today : start;
    const boundedEnd = end > today ? today : end < earliest ? earliest : end;
    return boundedStart <= boundedEnd
        ? { start: boundedStart, end: boundedEnd, earliest, today }
        : { start: boundedEnd, end: boundedStart, earliest, today };
}

async function fetchShopInfo(admin) {
    const response = await admin.graphql(
        `#graphql
        query ShopInfoForAudit {
          shop {
            currencyCode
            myshopifyDomain
            primaryDomain { url }
          }
        }`,
    );
    const json = await response.json();
    if (json.errors?.length) throw new Error(json.errors[0].message);
    return {
        shopUrl: json.data?.shop?.primaryDomain?.url || "",
        shopCurrency: json.data?.shop?.currencyCode || "USD",
        shopDomain: json.data?.shop?.myshopifyDomain || "unknown-shop",
    };
}

function isRetryableShopifyQLError(message = "") {
    return /rate limit|throttl|temporar|timeout|timed out|service unavailable|internal server|502|503|504/i.test(message);
}

async function runShopifyQL(admin, query, { limit = SHOPIFYQL_ROW_LIMIT, debug = false } = {}) {
    const limitedQuery = /\bLIMIT\b/i.test(query) ? query : `${query} LIMIT ${limit}`;
    const startedAt = Date.now();

    for (let attempt = 1; attempt <= SHOPIFYQL_MAX_ATTEMPTS; attempt += 1) {
        try {
            const response = await admin.graphql(
                `#graphql
      query RunShopifyQL($query: String!) {
        shopifyqlQuery(query: $query) {
          tableData {
            columns {
              name
              dataType
              displayName
            }
            rows
          }
          parseErrors
        }
      }`,
                { variables: { query: limitedQuery } },
            );
            const json = await response.json();
            const requestId = extractRequestId(response, json);
            const elapsedMs = Date.now() - startedAt;
            const graphError = json.errors?.[0]?.message || "";

            if (graphError && isRetryableShopifyQLError(graphError) && attempt < SHOPIFYQL_MAX_ATTEMPTS) {
                const retryDelayMs = SHOPIFYQL_RETRY_BASE_MS * (2 ** (attempt - 1));
                console.warn(`[ShopifyQL] temporary failure; retry ${attempt + 1}/${SHOPIFYQL_MAX_ATTEMPTS} in ${retryDelayMs}ms`);
                await wait(retryDelayMs);
                continue;
            }

            if (json.errors?.length) {
                return { rows: [], error: graphError, truncated: false, requestId, rawJson: debug ? json : null, elapsedMs, attempts: attempt };
            }

            const result = json.data?.shopifyqlQuery;
            if (result?.parseErrors?.length) {
                return { rows: [], error: result.parseErrors.join("; "), truncated: false, requestId, rawJson: debug ? json : null, elapsedMs, attempts: attempt };
            }

            const columns = result?.tableData?.columns || [];
            const rawRows = result?.tableData?.rows || [];
            const rows = rawRows.map((row) => {
                // Shopify API may return rows as arrays (positional) or as objects
                // (keyed by column name). Handle both formats.
                if (Array.isArray(row)) {
                    const obj = {};
                    columns.forEach((col, i) => {
                        obj[col.name] = row[i];
                    });
                    return obj;
                }
                // Row is already an object with named keys — use it directly.
                return row;
            });

            // If we came back with exactly the number of rows we asked for, the
            // result set was almost certainly cut short and totals are understated.
            console.info(`[ShopifyQL] ${elapsedMs}ms · ${rows.length} rows · ${attempt} attempt(s) · ${limitedQuery.slice(0, 100)}`);
            if (debug) console.debug(`[ShopifyQL debug]`, JSON.stringify(json, null, 2));
            return { rows, error: null, truncated: rows.length >= limit, requestId, rawJson: debug ? json : null, elapsedMs, attempts: attempt };
        } catch (err) {
            const message = err?.message || "ShopifyQL request failed.";
            if (isRetryableShopifyQLError(message) && attempt < SHOPIFYQL_MAX_ATTEMPTS) {
                const retryDelayMs = SHOPIFYQL_RETRY_BASE_MS * (2 ** (attempt - 1));
                console.warn(`[ShopifyQL] ${message}; retry ${attempt + 1}/${SHOPIFYQL_MAX_ATTEMPTS} in ${retryDelayMs}ms`);
                await wait(retryDelayMs);
                continue;
            }
            console.error(`[ShopifyQL Fetch Error]:`, message);
            return { rows: [], error: message, truncated: false, requestId: null, rawJson: null, elapsedMs: Date.now() - startedAt, attempts: attempt };
        }
    }

    return { rows: [], error: "ShopifyQL request failed after retries.", truncated: false, requestId: null, rawJson: null, elapsedMs: Date.now() - startedAt, attempts: SHOPIFYQL_MAX_ATTEMPTS };
}

export const loader = async ({ request }) => {
    const { admin, session } = await authenticate.admin(request);

    const url = new URL(request.url);
    const debug = url.searchParams.get("debug") === "1";
    const now = new Date();
    const { start, end, earliest, today } = normalizeCustomRange(url, now);
    const month = `${start}_to_${end}`;
    const displayRange = `${formatDate(start)} – ${formatDate(end)}`;

    const report = (async () => {

        // These requests do not depend on one another, so start them together. Total
        // waiting time is now close to the slowest request, not the sum of all requests.
        const [productsResult, shopResult, landingSessionTotals, salesTotals, salesOrderTotal, inventoryTotals] = await Promise.all([
            getProductCatalog(admin, session.shop).then(
                (catalog) => ({ ...catalog, error: null }),
                (err) => ({ products: [], error: err?.message || "Failed to load products." }),
            ),
            fetchShopInfo(admin).catch(() => ({ shopUrl: "", shopCurrency: "USD", shopDomain: "unknown-shop" })),
            runWithAnalyticsCache({
                shop: session.shop, dataset: "product-landing-sessions-daily-v2", rangeStart: start, rangeEnd: end,
                run: () => runShopifyQL(admin, `FROM sessions SHOW sessions, sessions_that_reached_checkout, sessions_that_completed_checkout, conversion_rate WHERE landing_page_type = 'product' GROUP BY day, landing_page_path SINCE ${start} UNTIL ${end}`, { debug }),
            }),
            runWithAnalyticsCache({
                shop: session.shop, dataset: "sales-breakdown-daily-v5", rangeStart: start, rangeEnd: end,
                run: () => runShopifyQL(admin, `FROM sales SHOW orders, quantity_ordered, net_items_sold, reversed_quantity, gross_sales, discounts, gross_sales_reversals, net_sales, shipping_charges, return_fees, taxes, total_sales GROUP BY day, product_id SINCE ${start} UNTIL ${end}`, { debug }),
            }),
            runWithAnalyticsCache({
                shop: session.shop, dataset: "sales-unique-orders-v1", rangeStart: start, rangeEnd: end,
                run: () => runShopifyQL(admin, `FROM sales SHOW orders SINCE ${start} UNTIL ${end}`, { debug }),
            }),
            runWithAnalyticsCache({
                shop: session.shop, dataset: "inventory-daily-v2", rangeStart: start, rangeEnd: end,
                run: () => runShopifyQL(admin, `FROM inventory SHOW starting_inventory_units, ending_inventory_units, first_day_in_inventory GROUP BY day, product_id SINCE ${start} UNTIL ${end}`, { debug }),
            }),
        ]);

        const products = productsResult.products;
        const productsError = productsResult.error;
        const { shopUrl, shopCurrency } = shopResult;

        // Helper: extract the product handle from a landing_page_path like
        // "/products/my-handle" or "/products/my-handle?variant=123".
        function handleFromPath(path) {
            if (!path) return null;
            const match = path.match(/\/products\/([^/?#]+)/);
            return match ? match[1] : null;
        }

        const dayValue = (value) => String(value || "").slice(0, 10);
        const analyticsKey = (day, identity) => `${day}|${identity}`;
        const sessionByHandle = {};
        landingSessionTotals.rows.forEach((row) => {
            const handle = handleFromPath(row.landing_page_path);
            const day = dayValue(row.day);
            if (!handle || !day) return;
            const key = analyticsKey(day, handle);
            const current = sessionByHandle[key] || { sessions: 0, reachedCheckout: 0, completedCheckoutSessions: 0, conversionRate: 0 };
            current.sessions += Number(row.sessions) || 0;
            current.reachedCheckout += Number(row.sessions_that_reached_checkout) || 0;
            current.completedCheckoutSessions += Number(row.sessions_that_completed_checkout) || 0;
            current.conversionRate = current.sessions > 0 ? current.completedCheckoutSessions / current.sessions : 0;
            sessionByHandle[key] = current;
        });

        const salesByProduct = {};
        let unattributedSales = null;
        salesTotals.rows.forEach((row) => {
            const key = numericId(row.product_id);
            const day = dayValue(row.day);
            const values = {
                orders: Number(row.orders) || 0,
                quantityOrdered: Number(row.quantity_ordered) || 0,
                netItemsSold: Number(row.net_items_sold) || 0,
                reversedQuantity: Number(row.reversed_quantity) || 0,
                grossSales: Number(row.gross_sales) || 0,
                discounts: Number(row.discounts) || 0,
                salesReversals: Number(row.gross_sales_reversals) || 0,
                netSales: Number(row.net_sales) || 0,
                shippingCharges: Number(row.shipping_charges) || 0,
                returnFees: Number(row.return_fees) || 0,
                taxes: Number(row.taxes) || 0,
                totalSales: Number(row.total_sales) || 0,
            };
            if (!key || !day) {
                unattributedSales = values;
                return;
            }
            salesByProduct[analyticsKey(day, key)] = values;
        });

        const inventoryByProduct = {};
        inventoryTotals.rows.forEach((row) => {
            const key = numericId(row.product_id);
            const day = dayValue(row.day);
            if (!key || !day) return;
            inventoryByProduct[analyticsKey(day, key)] = {
                firstDayInInventory: row.first_day_in_inventory || null,
                startingInventory: row.starting_inventory_units ?? null,
                endingInventory: row.ending_inventory_units ?? null,
            };
        });

        const cleanShopUrl = shopUrl ? shopUrl.replace(/\/$/, "") : "";

        const daysByProduct = {};
        const registerDay = (key, day) => {
            if (!key || !day) return;
            if (!daysByProduct[key]) daysByProduct[key] = new Set();
            daysByProduct[key].add(day);
        };
        Object.keys(salesByProduct).forEach((value) => { const [day, key] = value.split("|"); registerDay(key, day); });
        Object.keys(inventoryByProduct).forEach((value) => { const [day, key] = value.split("|"); registerDay(key, day); });
        const productByHandle = Object.fromEntries(products.map((product) => [product.handle || "", numericId(product.id)]));
        Object.keys(sessionByHandle).forEach((value) => {
            const separator = value.indexOf("|");
            const day = value.slice(0, separator);
            const handle = value.slice(separator + 1);
            registerDay(productByHandle[handle], day);
        });

        const rows = products.flatMap((product) => {
            const key = numericId(product.id);
            const handle = product.handle || "";
            const productDays = [...(daysByProduct[key] || [])].sort();
            if (!productDays.length) productDays.push(null);
            return productDays.map((day) => {
                const dailyKeyByHandle = day ? analyticsKey(day, handle) : "";
                const dailyKeyByProduct = day ? analyticsKey(day, key) : "";
                const session = sessionByHandle[dailyKeyByHandle] || { sessions: 0, reachedCheckout: 0, completedCheckoutSessions: 0, conversionRate: 0 };
                const inventory = inventoryByProduct[dailyKeyByProduct] || {
                    firstDayInInventory: null,
                    startingInventory: null,
                    endingInventory: null,
                };
                const sales = salesByProduct[dailyKeyByProduct] || {
                    orders: 0,
                    quantityOrdered: 0,
                    netItemsSold: 0,
                    reversedQuantity: 0,
                    grossSales: 0,
                    discounts: 0,
                    salesReversals: 0,
                    netSales: 0,
                    shippingCharges: 0,
                    returnFees: 0,
                    taxes: 0,
                    totalSales: 0,
                };

                const prodUrl = cleanShopUrl && product.handle ? `${cleanShopUrl}/products/${product.handle}` : "";

                return {
                    day,
                    productId: key,
                    title: product.title,
                    status: product.status || "",
                    productType: product.productType || "",
                    tags: product.tags || [],
                    productUrl: prodUrl,
                    createdAt: product.createdAt || null,
                    firstDayInInventory: inventory.firstDayInInventory,
                    startingInventory: inventory.startingInventory,
                    endingInventory: inventory.endingInventory,
                    landingSessions: session.sessions,
                    completedCheckoutSessions: session.completedCheckoutSessions,
                    ...sales,
                };
            });
        });

        const analyticsQueries = [
            { label: "Product landing sessions / completed checkouts", result: landingSessionTotals },
            { label: "Sale", result: salesTotals },
            { label: "Unique order total", result: salesOrderTotal },
            { label: "Inventory (first day / starting / ending)", result: inventoryTotals },
        ];

        const analyticsErrors = analyticsQueries.flatMap(({ label, result }) => {
            if (result.error) return [{ label, message: result.error }];
            if (result.truncated) {
                return [{
                    label,
                    message: `Result set hit the ${SHOPIFYQL_ROW_LIMIT.toLocaleString()}-row limit, so some products may be missing or understated.`,
                }];
            }
            return [];
        });

        const shopifyqlDebug = {
            landingSessionTotals: { requestId: landingSessionTotals.requestId, rowCount: landingSessionTotals.rows.length, truncated: landingSessionTotals.truncated, rawJson: landingSessionTotals.rawJson, error: landingSessionTotals.error, elapsedMs: landingSessionTotals.elapsedMs, attempts: landingSessionTotals.attempts, cacheStatus: landingSessionTotals.cacheStatus },
            salesTotals: { requestId: salesTotals.requestId, rowCount: salesTotals.rows.length, truncated: salesTotals.truncated, rawJson: salesTotals.rawJson, error: salesTotals.error, elapsedMs: salesTotals.elapsedMs, attempts: salesTotals.attempts, cacheStatus: salesTotals.cacheStatus },
            salesOrderTotal: { requestId: salesOrderTotal.requestId, rowCount: salesOrderTotal.rows.length, truncated: salesOrderTotal.truncated, rawJson: salesOrderTotal.rawJson, error: salesOrderTotal.error, elapsedMs: salesOrderTotal.elapsedMs, attempts: salesOrderTotal.attempts, cacheStatus: salesOrderTotal.cacheStatus },
            inventoryTotals: { requestId: inventoryTotals.requestId, rowCount: inventoryTotals.rows.length, truncated: inventoryTotals.truncated, rawJson: inventoryTotals.rawJson, error: inventoryTotals.error, elapsedMs: inventoryTotals.elapsedMs, attempts: inventoryTotals.attempts, cacheStatus: inventoryTotals.cacheStatus },
        };

        return {
            rows, shopCurrency, productsError, analyticsErrors, shopifyqlDebug, unattributedSales,
            uniqueOrderTotal: Number(salesOrderTotal.rows[0]?.orders) || 0,
            catalogStatus: productsResult.source || "unavailable",
            catalogRefreshedAt: productsResult.refreshedAt || null,
        };
    })();

    return { month, start, end, earliest, today, displayRange, report };
};

function formatMoney(amount, currency = "USD") {
    const value = Number(amount) || 0;
    const code = currency || "USD";
    try {
        return new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: code,
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        }).format(value);
    } catch {
        return `${code} ${value.toFixed(2)}`;
    }
}

function formatDate(value) {
    if (!value) return "—";
    // ShopifyQL returns calendar dates as bare "YYYY-MM-DD". `new Date` reads
    // those as UTC midnight, which renders as the previous day west of GMT, so
    // pin them to local time instead.
    const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value);
    if (isNaN(d.getTime())) return String(value);
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function formatDateTime(value) {
    if (!value) return "—";
    const d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    return d.toLocaleString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
    });
}

const REPORT_DIMENSIONS = {
    productId: { label: "Product ID", info: "Shopify's unique numeric product identifier." },
    title: { label: "Title", info: "Current product title from the catalog." },
    status: { label: "Status", info: "Current Active, Draft, or Archived product status." },
    productType: { label: "Type", info: "Current Shopify product type." },
    tags: { label: "Tags", info: "Current product tags." },
    month: { label: "Month", info: "Groups activity by full calendar month." },
    week: { label: "Week", info: "Groups activity by Monday-to-Sunday week." },
    day: { label: "Day", info: "Groups activity by calendar day." },
};

const REPORT_METRICS = {
    productUrl: { label: "URL", info: "Current online-store product URL.", type: "text" },
    createdAt: { label: "Created At", info: "Date the product record was created.", type: "date" },
    firstDayInInventory: { label: "First Day in Inventory", info: "First inventory date reported inside the selected range.", type: "date" },
    startingInventory: { label: "Starting Inventory", info: "Inventory at the start of the selected group." },
    endingInventory: { label: "Ending Inventory", info: "Inventory at the end of the selected group." },
    landingSessions: { label: "Landing Sessions", info: "Sessions whose first storefront page was this product." },
    orders: { label: "Orders", info: "Unique orders containing the product." },
    quantityOrdered: { label: "Quantity Ordered", info: "Units ordered before reversals." },
    netItemsSold: { label: "Net Items Sold", info: "Units sold after reversals." },
    reversedQuantity: { label: "Reversed Quantity", info: "Units reversed through returns, refunds, cancellations, or edits." },
    grossSales: { label: "Gross Sales", info: "Product sales before discounts and reversals.", money: true },
    discounts: { label: "Discounts", info: "Discount value attributed to the product.", money: true },
    salesReversals: { label: "Sales Reversals", info: "Sales value reversed by returns, refunds, cancellations, or edits.", money: true },
    netSales: { label: "Net Sales", info: "Gross sales after discounts and reversals.", money: true },
    shippingCharges: { label: "Shipping Charges", info: "Shipping attributed by Shopify to the product.", money: true },
    returnFees: { label: "Return Fees", info: "Return fees attributed to the product.", money: true },
    taxes: { label: "Taxes", info: "Taxes attributed to the product.", money: true },
    totalSales: { label: "Total Sales", info: "Final Shopify total sales attributed to the product.", money: true },
};

const DEFAULT_DIMENSIONS = ["productId", "title", "status", "productType", "tags"];
const DEFAULT_METRICS = ["productUrl", "startingInventory", "endingInventory", "landingSessions", "orders", "netItemsSold", "totalSales"];

function reportWeek(day) {
    if (!day) return "—";
    const date = new Date(`${day}T00:00:00`);
    const weekday = date.getDay();
    date.setDate(date.getDate() + (weekday === 0 ? -6 : 1 - weekday));
    return `Week of ${formatDate(fmtDate(date))}`;
}

function aggregateReportRows(sourceRows, dimensions) {
    const dimensionValue = (row, key) => {
        if (key === "month") return row.day ? formatDate(`${row.day.slice(0, 7)}-01`).replace(/ \d{1,2},/, "") : "—";
        if (key === "week") return reportWeek(row.day);
        if (key === "day") return formatDate(row.day);
        if (key === "tags") return (row.tags || []).join(", ");
        return row[key] || "—";
    };
    const groups = new Map();
    sourceRows.forEach((row) => {
        const dimensionData = Object.fromEntries(dimensions.map((key) => [key, dimensionValue(row, key)]));
        const groupKey = JSON.stringify(dimensionData);
        if (!groups.has(groupKey)) groups.set(groupKey, { ...dimensionData, __rows: [] });
        groups.get(groupKey).__rows.push(row);
    });
    return [...groups.values()].map((group) => {
        const dated = group.__rows.filter((row) => row.day).sort((a, b) => a.day.localeCompare(b.day));
        const firstInventory = dated.find((row) => row.startingInventory !== null && row.startingInventory !== undefined);
        const lastInventory = [...dated].reverse().find((row) => row.endingInventory !== null && row.endingInventory !== undefined);
        const result = { ...group };
        delete result.__rows;
        Object.keys(REPORT_METRICS).forEach((key) => {
            if (["productUrl", "createdAt"].includes(key)) result[key] = group.__rows.find((row) => row[key])?.[key] || "";
            else if (key === "firstDayInInventory") result[key] = group.__rows.map((row) => row[key]).filter(Boolean).sort()[0] || null;
            else if (key === "startingInventory") result[key] = firstInventory?.startingInventory ?? null;
            else if (key === "endingInventory") result[key] = lastInventory?.endingInventory ?? null;
            else result[key] = group.__rows.reduce((sum, row) => sum + (Number(row[key]) || 0), 0);
        });
        return result;
    });
}

export default function ProductsAudit() {
    const loaderData = useLoaderData();
    const navigation = useNavigation();
    const isRefreshing = navigation.state !== "idle";

    return (
        <Suspense fallback={<ProductsAuditLoading displayRange={loaderData.displayRange} />}>
            <Await
                resolve={loaderData.report}
                errorElement={<ProductsAuditLoadError />}
            >
                {(report) => (
                    <ProductsAuditContent
                        loaderData={{ ...loaderData, ...report }}
                        isRefreshing={isRefreshing}
                    />
                )}
            </Await>
        </Suspense>
    );
}

function ProductsAuditLoading({ displayRange }) {
    return (
        <s-page heading="Product Audit" className="audit-page">
            <style>{`
                .audit-loading { min-height: 220px; display: flex; align-items: center; justify-content: center; gap: 14px; color: #4a4a4a; }
                .audit-spinner { width: 24px; height: 24px; border: 3px solid #dfe3e8; border-top-color: #005bd3; border-radius: 50%; animation: audit-spin .8s linear infinite; }
                @keyframes audit-spin { to { transform: rotate(360deg); } }
                .audit-date-section, .audit-builder-sidebar { border-color: #e1e3e5; box-shadow: 0 1px 0 rgba(0,0,0,0.05); }
                .audit-table-header-cell { background: #f7f7f8 !important; border-right: 1px solid #e8ebef; border-bottom: 2px solid #d2d5d8; color: #303030 !important; }
                .audit-product-row.even { background: #fff; }
                .audit-product-row.odd { background: #fafafb; }
                .audit-product-row:hover, .audit-product-row:hover > td:first-child { background: #edf2f7 !important; }
                .audit-product-row > td { border-right: 1px solid #e8ebef; color: #303030; font-weight: 500; }
                .audit-builder-sidebar { scrollbar-color: #b5b7ba transparent; scrollbar-width: thin; }
            `}</style>
            <s-section>
                <div className="audit-loading" role="status" aria-live="polite">
                    <div className="audit-spinner" />
                    <div>
                        <strong>Loading product report…</strong>
                        <div>Fetching and matching data for {displayRange}.</div>
                    </div>
                </div>
            </s-section>
        </s-page>
    );
}

function ProductsAuditLoadError() {
    return (
        <s-page heading="Product Audit">
            <s-section>
                <s-banner tone="critical">The product report could not be loaded. Please refresh and try again.</s-banner>
            </s-section>
        </s-page>
    );
}

function ProductsAuditContent({ loaderData, isRefreshing }) {
    const { rows, month, start, end, earliest, today, displayRange, shopCurrency, productsError, analyticsErrors, shopifyqlDebug, catalogStatus, catalogRefreshedAt, unattributedSales, uniqueOrderTotal } = loaderData;
    const [searchParams, setSearchParams] = useSearchParams();
    // Every money value on this page is reported in the store's default currency.
    const currency = shopCurrency || "USD";
    const [currentPage, setCurrentPage] = useState(1);
    const [exportOpen, setExportOpen] = useState(false);
    const [selectedDimensions, setSelectedDimensions] = useState(DEFAULT_DIMENSIONS);
    const [selectedMetrics, setSelectedMetrics] = useState(DEFAULT_METRICS);
    const [dimensionPickerOpen, setDimensionPickerOpen] = useState(false);
    const [metricPickerOpen, setMetricPickerOpen] = useState(false);
    const [filters, setFilters] = useState([]);
    const [draggedItem, setDraggedItem] = useState(null);
    const [sortConfig, setSortConfig] = useState({ key: null, direction: "asc" });
    const hasUnattributedSales = Object.values(unattributedSales || {}).some((value) => Number(value) !== 0);

    const filteredRows = useMemo(() => {
        const grouped = aggregateReportRows(rows, selectedDimensions);
        return grouped.filter((row) => filters.every((filter) => {
            if (!filter.value) return true;
            const actual = row[filter.field];
            if (filter.kind === "number") {
                const left = Number(actual) || 0;
                const right = Number(filter.value);
                if (filter.operator === "gt") return left > right;
                if (filter.operator === "lt") return left < right;
                return left === right;
            }
            const left = String(actual || "").toLowerCase();
            const right = String(filter.value).toLowerCase();
            return filter.operator === "equals" ? left === right : left.includes(right);
        }));
    }, [rows, selectedDimensions, filters]);

    const sortedRows = useMemo(() => {
        if (!sortConfig.key) return filteredRows;
        const direction = sortConfig.direction === "asc" ? 1 : -1;
        return [...filteredRows].sort((leftRow, rightRow) => {
            const left = leftRow[sortConfig.key];
            const right = rightRow[sortConfig.key];
            const leftMissing = left === null || left === undefined || left === "";
            const rightMissing = right === null || right === undefined || right === "";
            if (leftMissing || rightMissing) {
                if (leftMissing && rightMissing) return 0;
                return leftMissing ? 1 : -1;
            }
            if (typeof left === "number" || typeof right === "number") return ((Number(left) || 0) - (Number(right) || 0)) * direction;
            return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" }) * direction;
        });
    }, [filteredRows, sortConfig]);

    const tableTotals = useMemo(() => aggregateReportRows(filteredRows, [])[0] || {}, [filteredRows]);
    const totalPages = Math.ceil(sortedRows.length / PRODUCT_PAGE_SIZE) || 1;
    const safePage = Math.min(Math.max(1, currentPage), totalPages);

    const paginatedRows = useMemo(() => {
        const startIdx = (safePage - 1) * PRODUCT_PAGE_SIZE;
        return sortedRows.slice(startIdx, startIdx + PRODUCT_PAGE_SIZE);
    }, [sortedRows, safePage]);

    const handleSort = (key) => {
        setSortConfig((current) => ({ key, direction: current.key === key && current.direction === "asc" ? "desc" : "asc" }));
        setCurrentPage(1);
    };

    // Summary metrics
    const summaryMetrics = useMemo(() => {
        const totalLandingSessions = filteredRows.reduce((s, r) => s + (r.landingSessions || 0), 0);
        const totalCompletedCheckoutSessions = filteredRows.reduce((s, r) => s + (r.completedCheckoutSessions || 0), 0);
        const totalOrders = filteredRows.reduce((s, r) => s + (r.orders || 0), 0);
        const salesTotals = filteredRows.reduce((totals, row) => ({
            grossSales: totals.grossSales + (row.grossSales || 0),
            discounts: totals.discounts + (row.discounts || 0),
            salesReversals: totals.salesReversals + (row.salesReversals || 0),
            netSales: totals.netSales + (row.netSales || 0),
            shippingCharges: totals.shippingCharges + (row.shippingCharges || 0),
            returnFees: totals.returnFees + (row.returnFees || 0),
            taxes: totals.taxes + (row.taxes || 0),
            totalSales: totals.totalSales + (row.totalSales || 0),
        }), { grossSales: 0, discounts: 0, salesReversals: 0, netSales: 0, shippingCharges: 0, returnFees: 0, taxes: 0, totalSales: 0 });
        const convRate = totalLandingSessions > 0 ? ((totalCompletedCheckoutSessions / totalLandingSessions) * 100).toFixed(1) : "0.0";
        return { totalLandingSessions, totalOrders, ...salesTotals, convRate };
    }, [filteredRows]);
    const overallRow = useMemo(() => aggregateReportRows(rows, [])[0] || {}, [rows]);

    const navigateRange = (newStart, newEnd) => {
        const next = new URLSearchParams(searchParams);
        next.set("start", newStart);
        next.set("end", newEnd);
        next.delete("filterType");
        next.delete("date");
        next.delete("month");
        setSearchParams(next);
        setCurrentPage(1);
    };

    const createExportRows = (sourceRows) => sourceRows.map((row) => Object.fromEntries([
        ...selectedDimensions.map((key) => [REPORT_DIMENSIONS[key].label, row[key] ?? ""]),
        ...selectedMetrics.map((key) => {
            const metric = REPORT_METRICS[key];
            const label = metric.money ? `${metric.label} (${currency})` : metric.label;
            const value = metric.type === "date" ? formatDate(row[key]) : row[key] ?? "";
            return [label, value];
        }),
    ]));

    const moveSelectedItem = (kind, targetKey) => {
        if (!draggedItem || draggedItem.kind !== kind || draggedItem.key === targetKey) return;
        const setter = kind === "dimension" ? setSelectedDimensions : setSelectedMetrics;
        setter((items) => {
            const next = items.filter((key) => key !== draggedItem.key);
            next.splice(next.indexOf(targetKey), 0, draggedItem.key);
            return next;
        });
        setDraggedItem(null);
    };

    const downloadTextFile = (content, filename, mimeType) => {
        const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
    };

    const escapeCsv = (value) => {
        const text = value === null || value === undefined ? "" : String(value);
        return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };

    const escapeXml = (value) => String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");

    const xmlTag = (label) => label
        .replace(/\([^)]*\)/g, "")
        .trim()
        .replace(/[^a-zA-Z0-9]+(.)/g, (_, char) => char.toUpperCase())
        .replace(/^[A-Z]/, (char) => char.toLowerCase()) || "value";

    const exportReport = (scope, format) => {
        const sourceRows = scope === "page" ? paginatedRows : filteredRows;
        const exportRows = createExportRows(sourceRows);
        const scopeName = scope === "page" ? `page-${safePage}` : "all-results";
        const baseName = `Product_Audit_${month}_${scopeName}`;

        if (format === "csv") {
            const headers = exportRows.length ? Object.keys(exportRows[0]) : [];
            const csv = [
                headers.map(escapeCsv).join(","),
                ...exportRows.map((row) => headers.map((header) => escapeCsv(row[header])).join(",")),
            ].join("\r\n");
            downloadTextFile(`\uFEFF${csv}`, `${baseName}.csv`, "text/csv");
        } else if (format === "xml") {
            const productsXml = exportRows.map((row) => {
                const fields = Object.entries(row)
                    .map(([label, value]) => `    <${xmlTag(label)}>${escapeXml(value)}</${xmlTag(label)}>`)
                    .join("\n");
                return `  <product>\n${fields}\n  </product>`;
            }).join("\n");
            const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<productAudit scope="${scopeName}" range="${escapeXml(displayRange)}">\n${productsXml}\n</productAudit>\n`;
            downloadTextFile(xml, `${baseName}.xml`, "application/xml");
        } else {
            const jsonl = exportRows.map((row) => JSON.stringify(row)).join("\n");
            downloadTextFile(jsonl ? `${jsonl}\n` : "", `${baseName}.jsonl`, "application/x-ndjson");
        }

        setExportOpen(false);
    };

    const startIndex = filteredRows.length === 0 ? 0 : (safePage - 1) * PRODUCT_PAGE_SIZE + 1;
    const endIndex = Math.min(safePage * PRODUCT_PAGE_SIZE, filteredRows.length);

    const renderPagination = () => {
        if (filteredRows.length <= PRODUCT_PAGE_SIZE) return null;

        return (
            <div
                style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "10px 14px",
                    background: "#ffffff",
                    border: "1px solid #e1e3e5",
                    borderRadius: "8px",
                    margin: "12px 0",
                    flexWrap: "wrap",
                    gap: "12px",
                }}
            >
                <div style={{ fontSize: "13px", color: "#6d7175" }}>
                    Showing <strong>{startIndex}–{endIndex}</strong> of <strong>{filteredRows.length}</strong> products
                    (Page <strong>{safePage}</strong> of <strong>{totalPages}</strong>)
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <button
                        type="button"
                        disabled={safePage <= 1}
                        onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                        style={{
                            padding: "6px 12px",
                            fontSize: "13px",
                            fontWeight: "600",
                            borderRadius: "6px",
                            border: "1px solid #c9cccf",
                            backgroundColor: safePage <= 1 ? "#f1f2f4" : "#ffffff",
                            color: safePage <= 1 ? "#8c9196" : "#202223",
                            cursor: safePage <= 1 ? "not-allowed" : "pointer",
                        }}
                    >
                        Previous
                    </button>

                    <select
                        value={safePage}
                        onChange={(e) => setCurrentPage(Number(e.target.value))}
                        style={{
                            padding: "6px 10px",
                            fontSize: "13px",
                            borderRadius: "6px",
                            border: "1px solid #c9cccf",
                            backgroundColor: "#ffffff",
                            cursor: "pointer",
                        }}
                    >
                        {Array.from({ length: totalPages }, (_, i) => i + 1).map((pg) => (
                            <option key={pg} value={pg}>
                                Page {pg}
                            </option>
                        ))}
                    </select>

                    <button
                        type="button"
                        disabled={safePage >= totalPages}
                        onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                        style={{
                            padding: "6px 12px",
                            fontSize: "13px",
                            fontWeight: "600",
                            borderRadius: "6px",
                            border: "1px solid #c9cccf",
                            backgroundColor: safePage >= totalPages ? "#f1f2f4" : "#ffffff",
                            color: safePage >= totalPages ? "#8c9196" : "#202223",
                            cursor: safePage >= totalPages ? "not-allowed" : "pointer",
                        }}
                    >
                        Next
                    </button>
                </div>
            </div>
        );
    };

    const metricCardStyle = {
        background: "#ffffff",
        border: "1px solid #e1e3e5",
        borderRadius: "10px",
        padding: "16px 20px",
        display: "flex",
        flexDirection: "column",
        gap: "2px",
        boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
    };

    return (
        <s-page heading="Product Audit">
            <style>{`
                .audit-loading { min-height: 220px; display: flex; align-items: center; justify-content: center; gap: 14px; color: #4a4a4a; }
                .audit-spinner { width: 24px; height: 24px; border: 3px solid #dfe3e8; border-top-color: #005bd3; border-radius: 50%; animation: audit-spin .8s linear infinite; }
                .audit-refreshing { margin-bottom: 16px; padding: 10px 14px; border-radius: 7px; background: #eef4ff; color: #164c8c; font-size: 13px; }
                .audit-product-row { border-bottom: 1px solid #f1f2f4; transition: background .1s ease; }
                .audit-product-row.even { background: #fff; }
                .audit-product-row.odd { background: #fafbfc; }
                .audit-product-row:hover { background: #eef4fb; }
                .audit-product-row.even > td:first-child { background: #fff; }
                .audit-product-row.odd > td:first-child { background: #fafbfc; }
                .audit-product-row:hover > td:first-child { background: #eef4fb; }
                .audit-table-header-cell { position: sticky; top: 0; z-index: 3; background: #f4f5f6; }
                .audit-table-header-cell:first-child { left: 0; z-index: 5; box-shadow: 2px 0 4px rgba(0,0,0,0.08); }
                .audit-product-row > td:first-child { position: sticky; left: 0; z-index: 2; box-shadow: 2px 0 4px rgba(0,0,0,0.06); }
                .legacy-summary { display: none; }
                .audit-page { display: block; width: calc(100vw - 64px) !important; max-width: none !important; margin-inline: calc((100% - 100vw + 64px) / 2) !important; padding-inline: 0; box-sizing: border-box; }
                .audit-top-row { display: grid; grid-template-columns: minmax(0, 1fr) 310px; gap: 18px; align-items: start; width: calc(100vw - 64px); margin-left: calc((100% - 100vw + 64px) / 2); margin-bottom: 16px; }
                .audit-export-wrap { grid-column: 2; grid-row: 1; position: relative; z-index: 10; margin: 0 !important; padding-top: 6px; }
                .audit-date-section { grid-column: 1; grid-row: 1; min-width: 0; background: #fff; border: 1px solid #e1e3e5; border-radius: 10px; padding: 14px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); box-sizing: border-box; }
                .audit-content-grid { display: grid; grid-template-columns: minmax(0, 1fr) 310px; column-gap: 18px; align-items: start; width: calc(100vw - 64px); margin-left: calc((100% - 100vw + 64px) / 2); }
                .audit-left-column { grid-column: 1; min-width: 0; width: 100%; margin-bottom: 16px !important; }
                .audit-summary-section { padding-bottom: 8px; }
                .audit-section-spacer { grid-column: 1; height: 16px; }
                .audit-builder-layout { display: contents !important; }
                .audit-builder-sidebar { grid-column: 2; grid-row: 1 / span 20; position: sticky !important; top: 12px; width: 310px; max-height: calc(100vh - 24px) !important; overflow-y: auto; scrollbar-width: thin; box-sizing: border-box; padding: 12px; background: #fff; border: 1px solid #dfe3e8; border-radius: 12px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
                .audit-builder-placeholder { display: none !important; }
                @media (max-width: 1050px) {
                    .audit-page { width: calc(100vw - 40px) !important; margin-inline: calc((100% - 100vw + 40px) / 2) !important; }
                    .audit-top-row { grid-template-columns: minmax(0, 1fr) auto; gap: 12px; }
                    .audit-top-row, .audit-content-grid { width: calc(100vw - 40px); margin-left: calc((100% - 100vw + 40px) / 2); }
                    .audit-content-grid { grid-template-columns: 1fr; }
                    .audit-left-column { grid-column: 1; }
                    .audit-builder-sidebar { grid-column: 1; grid-row: auto; position: static !important; width: 100%; max-height: none !important; margin-bottom: 16px; }
                }
                @media (max-width: 680px) {
                    .audit-page { width: calc(100vw - 24px) !important; margin-inline: calc((100% - 100vw + 24px) / 2) !important; }
                    .audit-top-row { grid-template-columns: 1fr; }
                    .audit-top-row, .audit-content-grid { width: calc(100vw - 24px); margin-left: calc((100% - 100vw + 24px) / 2); }
                    .audit-date-section, .audit-export-wrap { grid-column: 1; grid-row: auto; }
                    .audit-export-wrap { justify-content: flex-start !important; padding-top: 0; }
                }
                @keyframes audit-spin { to { transform: rotate(360deg); } }
            `}</style>
            <div className="audit-top-row">
                <div
                    className="audit-export-wrap"
                    style={{
                        position: "relative",
                        display: "flex",
                        justifyContent: "flex-end",
                        marginBottom: "16px",
                    }}
                >
                    <button
                        type="button"
                        onClick={() => setExportOpen((open) => !open)}
                        disabled={isRefreshing || filteredRows.length === 0}
                        aria-expanded={exportOpen}
                        aria-haspopup="menu"
                        style={{
                            backgroundColor: "#107c41",
                            color: "#ffffff",
                            border: "none",
                            borderRadius: "6px",
                            padding: "8px 16px",
                            fontSize: "14px",
                            fontWeight: "600",
                            cursor: isRefreshing ? "wait" : filteredRows.length === 0 ? "not-allowed" : "pointer",
                            opacity: isRefreshing || filteredRows.length === 0 ? 0.65 : 1,
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "8px",
                            boxShadow: "0 2px 4px rgba(0,0,0,0.1)",
                        }}
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="7 10 12 15 17 10" />
                            <line x1="12" y1="15" x2="12" y2="3" />
                        </svg>
                        Export
                        <span aria-hidden="true">{exportOpen ? "▲" : "▼"}</span>
                    </button>
                    {exportOpen && !isRefreshing && (
                        <div
                            role="menu"
                            style={{
                                position: "absolute",
                                top: "calc(100% + 8px)",
                                right: 0,
                                zIndex: 20,
                                width: "320px",
                                padding: "12px",
                                border: "1px solid #c9cccf",
                                borderRadius: "10px",
                                background: "#ffffff",
                                boxShadow: "0 8px 24px rgba(0,0,0,0.16)",
                            }}
                        >
                            {[
                                { scope: "page", title: `Current page (${paginatedRows.length} products)` },
                                { scope: "all", title: `All results (${filteredRows.length} products)` },
                            ].map(({ scope, title }) => (
                                <div key={scope} style={{ marginBottom: scope === "page" ? "14px" : 0 }}>
                                    <div style={{ marginBottom: "7px", fontSize: "12px", fontWeight: 700, color: "#4a4a4a" }}>{title}</div>
                                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "6px" }}>
                                        {[
                                            { format: "csv", label: "CSV" },
                                            { format: "xml", label: "XML" },
                                            { format: "jsonl", label: "JSON Lines" },
                                        ].map(({ format, label }) => (
                                            <button
                                                key={format}
                                                type="button"
                                                role="menuitem"
                                                onClick={() => exportReport(scope, format)}
                                                style={{
                                                    padding: "7px 6px",
                                                    border: "1px solid #c9cccf",
                                                    borderRadius: "6px",
                                                    background: "#ffffff",
                                                    color: "#202223",
                                                    cursor: "pointer",
                                                    fontSize: "11px",
                                                    fontWeight: 600,
                                                }}
                                            >
                                                {label}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            ))}
                            <div style={{ marginTop: "10px", fontSize: "11px", lineHeight: 1.4, color: "#6d7175" }}>
                                All results respects the current timeframe and report filters.
                            </div>
                        </div>
                    )}
                </div>

                {isRefreshing && (
                    <div className="audit-refreshing" role="status" aria-live="polite">
                        Updating the report for your new selection… Export will be available when it finishes.
                    </div>
                )}

                <div className="audit-date-section">
                    <div style={{ display: "flex", alignItems: "end", gap: "12px", flexWrap: "wrap" }}>
                        <label style={{ display: "grid", gap: "5px", fontSize: "12px", fontWeight: 600 }}>
                            Start date
                            <input type="date" value={start} min={earliest} max={end} onChange={(event) => navigateRange(event.target.value, end)} style={{ padding: "8px 10px", border: "1px solid #c9cccf", borderRadius: "7px" }} />
                        </label>
                        <label style={{ display: "grid", gap: "5px", fontSize: "12px", fontWeight: 600 }}>
                            End date
                            <input type="date" value={end} min={start} max={today} onChange={(event) => navigateRange(start, event.target.value)} style={{ padding: "8px 10px", border: "1px solid #c9cccf", borderRadius: "7px" }} />
                        </label>
                        <div style={{ fontSize: "13px", color: "#4a4a4a", paddingBottom: "8px" }}>
                            <strong>{displayRange}</strong><br />Available from {formatDate(earliest)} to {formatDate(today)} (18 full calendar months).
                        </div>
                    </div>
                </div>
            </div>

            {productsError && (
                <s-box padding="base" background="critical" borderRadius="base" style={{ marginBottom: "16px" }}>
                    <s-paragraph style={{ margin: 0 }}>⚠️ Failed to load products: {productsError}</s-paragraph>
                </s-box>
            )}

            {analyticsErrors.length > 0 && (
                <s-box
                    padding="base"
                    background="subdued"
                    borderRadius="base"
                    style={{ marginBottom: "16px", border: "1px solid #e1e3e5" }}
                >
                    <s-paragraph style={{ margin: "0 0 8px 0", fontWeight: 600 }}>
                        ⚠️ Some analytics data could not be loaded or is incomplete:
                    </s-paragraph>
                    {analyticsErrors.map((e) => (
                        <s-paragraph key={e.label} style={{ margin: "0 0 4px 0", fontSize: "13px" }}>
                            <strong>{e.label}:</strong> {e.message}
                        </s-paragraph>
                    ))}
                </s-box>
            )}

            {hasUnattributedSales && (
                <s-box padding="base" background="subdued" borderRadius="base" style={{ marginBottom: "16px", border: "1px solid #b7c9e2" }}>
                    <s-paragraph style={{ margin: 0 }}>
                        <strong>Order-level sales note:</strong> Shopify returned some shipping, tax, fee, or adjustment amounts without a product ID. They are not divided across products, so product-row totals can differ from the store-wide sales report.
                    </s-paragraph>
                </s-box>
            )}

            <div className="audit-content-grid">
                {shopifyqlDebug && (
                    <details className="audit-left-column" style={{ marginBottom: "16px", background: "#f4f6f8", border: "1px solid #c9cccf", borderRadius: "8px", padding: "12px 16px", boxSizing: "border-box" }}>
                        <summary style={{ cursor: "pointer", fontWeight: "600", fontSize: "13px", color: "#202223" }}>
                            🔍 View ShopifyQL Debug Data
                        </summary>
                        <div style={{ marginTop: "12px", display: "flex", flexDirection: "column", gap: "12px", fontSize: "12px" }}>
                            <div style={{ color: "#4a4a4a" }}>
                                <strong>Product catalog:</strong> {catalogStatus}
                                {catalogRefreshedAt ? ` · refreshed ${formatDateTime(catalogRefreshedAt)}` : ""}
                            </div>
                            {Object.entries(shopifyqlDebug).map(([key, val]) => (
                                <div key={key} style={{ background: "#ffffff", padding: "10px", borderRadius: "6px", border: "1px solid #e1e3e5" }}>
                                    <div style={{ fontWeight: 600, color: "#005bd3", marginBottom: "4px" }}>
                                        Query: {key}
                                    </div>
                                    <div style={{ fontFamily: "monospace", color: "#202223", marginBottom: "6px" }}>
                                        <strong>x-request-id:</strong> {val.requestId || "N/A"}
                                        {" · "}
                                        <strong>rows:</strong> {val.rowCount ?? 0}
                                        {" · "}<strong>time:</strong> {val.elapsedMs ?? 0}ms
                                        {" · "}<strong>attempts:</strong> {val.attempts ?? 1}
                                        {val.cacheStatus && <>{" · "}<strong>cache:</strong> {val.cacheStatus}</>}
                                        {val.truncated && <span style={{ color: "#b98900" }}> (truncated — hit row limit)</span>}
                                    </div>
                                    <div>
                                        <strong>HTTP Response JSON:</strong>
                                        <pre style={{ background: "#f8f9fa", padding: "8px", borderRadius: "4px", overflowX: "auto", margin: "4px 0 0 0", fontSize: "11px" }}>
                                            <code>{JSON.stringify(val.rawJson, null, 2)}</code>
                                        </pre>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </details>
                )}

                <s-section heading="Selected metric totals" className="audit-left-column audit-summary-section">
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(165px, 1fr))", gap: "12px" }}>
                        {selectedMetrics.filter((key) => REPORT_METRICS[key].type !== "text" && !["firstDayInInventory", "startingInventory", "endingInventory"].includes(key)).map((key) => {
                            const metric = REPORT_METRICS[key];
                            const rawValue = key === "orders" ? uniqueOrderTotal : overallRow[key];
                            const value = metric.money ? formatMoney(rawValue, currency) : metric.type === "date" ? formatDate(rawValue) : rawValue ?? "—";
                            return <div key={key} style={metricCardStyle}><span style={{ fontSize: "12px", color: "#6d7175", fontWeight: 500 }}>{metric.label}{metric.money ? ` (${currency})` : ""}</span><span style={{ fontSize: "21px", fontWeight: 700 }}>{value}</span></div>;
                        })}
                    </div>
                </s-section>

                <s-section className="legacy-summary">
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "14px", marginBottom: "8px" }}>
                        <div style={metricCardStyle}>
                            <span style={{ fontSize: "12px", color: "#6d7175", fontWeight: 500 }}>Product Landing Sessions</span>
                            <span style={{ fontSize: "22px", fontWeight: 700, color: "#202223" }}>{summaryMetrics.totalLandingSessions.toLocaleString()}</span>
                        </div>
                        <div style={metricCardStyle}>
                            <span style={{ fontSize: "12px", color: "#6d7175", fontWeight: 500 }}>Product Orders (summed)</span>
                            <span style={{ fontSize: "22px", fontWeight: 700, color: "#202223" }}>{summaryMetrics.totalOrders.toLocaleString()}</span>
                        </div>
                        <div style={metricCardStyle}>
                            <span style={{ fontSize: "12px", color: "#6d7175", fontWeight: 500 }}>Gross Sales ({currency})</span>
                            <span style={{ fontSize: "22px", fontWeight: 700, color: "#202223" }}>{formatMoney(summaryMetrics.grossSales, currency)}</span>
                        </div>
                        <div style={metricCardStyle}>
                            <span style={{ fontSize: "12px", color: "#6d7175", fontWeight: 500 }}>Discounts ({currency})</span>
                            <span style={{ fontSize: "22px", fontWeight: 700, color: "#b98900" }}>{formatMoney(summaryMetrics.discounts, currency)}</span>
                        </div>
                        <div style={metricCardStyle}>
                            <span style={{ fontSize: "12px", color: "#6d7175", fontWeight: 500 }}>Sales Reversals ({currency})</span>
                            <span style={{ fontSize: "22px", fontWeight: 700, color: "#b42318" }}>{formatMoney(summaryMetrics.salesReversals, currency)}</span>
                        </div>
                        <div style={metricCardStyle}>
                            <span style={{ fontSize: "12px", color: "#6d7175", fontWeight: 500 }}>Net Sales ({currency})</span>
                            <span style={{ fontSize: "22px", fontWeight: 700, color: "#202223" }}>{formatMoney(summaryMetrics.netSales, currency)}</span>
                        </div>
                        <div style={metricCardStyle}>
                            <span style={{ fontSize: "12px", color: "#6d7175", fontWeight: 500 }}>Shipping Charges ({currency})</span>
                            <span style={{ fontSize: "22px", fontWeight: 700, color: "#202223" }}>{formatMoney(summaryMetrics.shippingCharges, currency)}</span>
                        </div>
                        <div style={metricCardStyle}>
                            <span style={{ fontSize: "12px", color: "#6d7175", fontWeight: 500 }}>Return Fees ({currency})</span>
                            <span style={{ fontSize: "22px", fontWeight: 700, color: "#202223" }}>{formatMoney(summaryMetrics.returnFees, currency)}</span>
                        </div>
                        <div style={metricCardStyle}>
                            <span style={{ fontSize: "12px", color: "#6d7175", fontWeight: 500 }}>Taxes ({currency})</span>
                            <span style={{ fontSize: "22px", fontWeight: 700, color: "#202223" }}>{formatMoney(summaryMetrics.taxes, currency)}</span>
                        </div>
                        <div style={metricCardStyle}>
                            <span style={{ fontSize: "12px", color: "#6d7175", fontWeight: 500 }}>Total Sales ({currency})</span>
                            <span style={{ fontSize: "22px", fontWeight: 700, color: "#107c41" }}>{formatMoney(summaryMetrics.totalSales, currency)}</span>
                        </div>
                        <div style={metricCardStyle}>
                            <span style={{ fontSize: "12px", color: "#6d7175", fontWeight: 500 }}>Landing Session Conversion Rate</span>
                            <span style={{ fontSize: "22px", fontWeight: 700, color: "#005bd3" }}>{summaryMetrics.convRate}%</span>
                        </div>
                    </div>
                </s-section>

                <div className="audit-builder-layout">
                    <div className="audit-builder-placeholder" />

                    <aside className="audit-builder-sidebar" style={{ position: "sticky", top: "12px", display: "grid", gap: "12px", maxHeight: "82vh", overflowY: "auto" }}>
                        {[
                            { kind: "metric", title: "Metrics", selected: selectedMetrics, setSelected: setSelectedMetrics, definitions: REPORT_METRICS, pickerOpen: metricPickerOpen, setPickerOpen: setMetricPickerOpen },
                            { kind: "dimension", title: "Dimensions", selected: selectedDimensions, setSelected: setSelectedDimensions, definitions: REPORT_DIMENSIONS, pickerOpen: dimensionPickerOpen, setPickerOpen: setDimensionPickerOpen },
                        ].map((section) => (
                            <div key={section.kind} style={{ background: "#fff", border: "1px solid #c9cccf", borderRadius: "10px", overflow: "hidden" }}>
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "11px 12px", fontWeight: 700, background: "#f7f8f9", borderBottom: "1px solid #e1e3e5" }}>
                                    {section.title}
                                    <button type="button" onClick={() => section.setPickerOpen((open) => !open)} aria-label={`Add ${section.kind}`} style={{ border: 0, background: "transparent", fontSize: "22px", cursor: "pointer" }}>+</button>
                                </div>
                                {section.pickerOpen && (
                                    <div style={{ padding: "8px", borderBottom: "1px solid #e1e3e5" }}>
                                        <select value="" onChange={(event) => { const key = event.target.value; if (key) section.setSelected((items) => [...items, key]); section.setPickerOpen(false); }} style={{ width: "100%", padding: "8px", border: "1px solid #c9cccf", borderRadius: "6px" }}>
                                            <option value="">Select {section.kind}...</option>
                                            {Object.entries(section.definitions).filter(([key]) => !section.selected.includes(key)).map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}
                                        </select>
                                    </div>
                                )}
                                {section.selected.map((key) => (
                                    <div key={key} draggable onDragStart={() => setDraggedItem({ kind: section.kind, key })} onDragOver={(event) => event.preventDefault()} onDrop={() => moveSelectedItem(section.kind, key)} style={{ display: "grid", gridTemplateColumns: "22px 1fr 24px 24px", alignItems: "center", gap: "5px", padding: "9px 10px", borderBottom: "1px solid #e8e9eb", fontSize: "13px" }}>
                                        <span title="Drag to reorder" style={{ cursor: "grab", letterSpacing: "-2px", color: "#6d7175" }}>⠿</span>
                                        <span>{section.definitions[key].label}</span>
                                        <button type="button" title={section.definitions[key].info} aria-label={`About ${section.definitions[key].label}`} style={{ border: 0, background: "transparent", cursor: "help", color: "#005bd3" }}>ⓘ</button>
                                        <button type="button" aria-label={`Remove ${section.definitions[key].label}`} onClick={() => section.setSelected((items) => items.filter((item) => item !== key))} disabled={section.selected.length === 1} style={{ border: 0, background: "transparent", cursor: "pointer", color: "#6d7175" }}>×</button>
                                    </div>
                                ))}
                            </div>
                        ))}

                        <div style={{ background: "#fff", border: "1px solid #c9cccf", borderRadius: "10px", overflow: "hidden" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "11px 12px", fontWeight: 700, background: "#f7f8f9", borderBottom: "1px solid #e1e3e5" }}>
                                Filters
                                <button type="button" onClick={() => setFilters((items) => [...items, { field: selectedDimensions[0], operator: "contains", value: "", kind: "text" }])} style={{ border: 0, background: "transparent", fontSize: "22px", cursor: "pointer" }}>+</button>
                            </div>
                            {filters.length === 0 && <div style={{ padding: "12px", color: "#6d7175", fontSize: "12px" }}>No filters applied.</div>}
                            {filters.map((filter, index) => (
                                <div key={index} style={{ padding: "10px", borderBottom: "1px solid #e8e9eb", display: "grid", gap: "7px" }}>
                                    <div style={{ display: "flex", gap: "6px" }}>
                                        <select value={filter.field} onChange={(event) => { const field = event.target.value; const kind = REPORT_METRICS[field] && !REPORT_METRICS[field].type ? "number" : "text"; setFilters((items) => items.map((item, i) => i === index ? { ...item, field, kind, operator: kind === "number" ? "equals" : "contains" } : item)); }} style={{ flex: 1, padding: "6px" }}>
                                            <optgroup label="Dimensions">{selectedDimensions.map((key) => <option key={key} value={key}>{REPORT_DIMENSIONS[key].label}</option>)}</optgroup>
                                            <optgroup label="Metrics">{selectedMetrics.filter((key) => !REPORT_METRICS[key].type).map((key) => <option key={key} value={key}>{REPORT_METRICS[key].label}</option>)}</optgroup>
                                        </select>
                                        <button type="button" onClick={() => setFilters((items) => items.filter((_, i) => i !== index))} style={{ border: 0, background: "transparent", cursor: "pointer" }}>×</button>
                                    </div>
                                    <div style={{ display: "flex", gap: "6px" }}>
                                        <select value={filter.operator} onChange={(event) => setFilters((items) => items.map((item, i) => i === index ? { ...item, operator: event.target.value } : item))} style={{ width: "105px", padding: "6px" }}>
                                            {filter.kind === "number" ? <><option value="equals">Equals</option><option value="gt">Greater than</option><option value="lt">Less than</option></> : <><option value="contains">Contains</option><option value="equals">Equals</option></>}
                                        </select>
                                        <input type={filter.kind === "number" ? "number" : "text"} value={filter.value} onChange={(event) => setFilters((items) => items.map((item, i) => i === index ? { ...item, value: event.target.value } : item))} placeholder="Value" style={{ minWidth: 0, flex: 1, padding: "6px" }} />
                                    </div>
                                </div>
                            ))}
                        </div>
                    </aside>
                </div>

                <div className="audit-section-spacer" aria-hidden="true" />
                <s-section heading={`Products (${filteredRows.length})`} className="audit-left-column">
                    {renderPagination()}
                    <div style={{ background: "#ffffff", border: "1px solid #e1e3e5", borderRadius: "10px", overflow: "auto", maxHeight: "70vh", boxShadow: "0 1px 4px rgba(0,0,0,0.06)" }}>
                        {filteredRows.length === 0 ? (
                            <div style={{ padding: "48px", textAlign: "center", color: "#8c9196" }}>
                                <div style={{ fontSize: "32px", marginBottom: "8px" }}>📦</div>
                                <div style={{ fontSize: "15px", fontWeight: 600 }}>No products found</div>
                                <div style={{ fontSize: "13px", marginTop: "4px" }}>Try adjusting your search or timeframe filters.</div>
                            </div>
                        ) : (
                            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                                <thead>
                                    <tr style={{
                                        background: "linear-gradient(180deg, #f7f8f9 0%, #f1f2f4 100%)",
                                        borderBottom: "2px solid #e1e3e5",
                                        textAlign: "left",
                                    }}>
                                        {[
                                            ...selectedDimensions.map((key) => ({ key, label: REPORT_DIMENSIONS[key].label, dimension: true })),
                                            ...selectedMetrics.map((key) => ({ key, label: `${REPORT_METRICS[key].label}${REPORT_METRICS[key].money ? ` (${currency})` : ""}`, dimension: false })),
                                        ].map((col) => (
                                            <th key={`${col.dimension ? "d" : "m"}-${col.key}`} className="audit-table-header-cell" style={{
                                                padding: "11px 10px",
                                                fontSize: "11px",
                                                fontWeight: 700,
                                                textTransform: "uppercase",
                                                letterSpacing: "0.5px",
                                                color: "#5c5f62",
                                                whiteSpace: "nowrap",
                                                minWidth: col.key === "title" ? "200px" : "105px",
                                            }}>
                                                <button type="button" onClick={() => handleSort(col.key)} aria-label={`Sort by ${col.label}`} style={{ width: "100%", padding: 0, border: 0, background: "transparent", color: "inherit", font: "inherit", letterSpacing: "inherit", textTransform: "inherit", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", whiteSpace: "nowrap" }}>
                                                    <span>{col.label}</span>
                                                    <span aria-hidden="true" style={{ width: "10px", display: "inline-flex", flexDirection: "column", alignItems: "center", fontSize: "8px", lineHeight: "7px", color: sortConfig.key === col.key ? "#202223" : "#9a9da1", flexShrink: 0 }}>
                                                        <span style={{ opacity: sortConfig.key !== col.key || sortConfig.direction === "asc" ? 1 : 0.25 }}>▲</span>
                                                        <span style={{ opacity: sortConfig.key !== col.key || sortConfig.direction === "desc" ? 1 : 0.25 }}>▼</span>
                                                    </span>
                                                </button>
                                            </th>
                                        ))}
                                    </tr>
                                    <tr style={{ background: "#f6f6f7", borderBottom: "1px solid #dfe3e8", fontWeight: 700 }}>
                                        {selectedDimensions.map((key, index) => <th key={`total-d-${key}`} style={{ padding: "10px", whiteSpace: "nowrap", textAlign: "left" }}>{index === 0 ? "Summary" : ""}</th>)}
                                        {selectedMetrics.map((key) => {
                                            const metric = REPORT_METRICS[key];
                                            const rawValue = tableTotals[key];
                                            const value = metric.type === "text" ? "—" : metric.money ? formatMoney(rawValue, currency) : metric.type === "date" ? formatDate(rawValue) : rawValue ?? "—";
                                            return <th key={`total-m-${key}`} style={{ padding: "10px", whiteSpace: "nowrap", textAlign: metric.type ? "left" : "right" }}>{value}</th>;
                                        })}
                                    </tr>
                                </thead>
                                <tbody>
                                    {paginatedRows.map((row, idx) => (
                                        <tr key={`${JSON.stringify(selectedDimensions.map((key) => row[key]))}-${idx}`} className={`audit-product-row ${idx % 2 === 0 ? "even" : "odd"}`}>
                                            {selectedDimensions.map((key) => <td key={`d-${key}`} style={{ padding: "10px", whiteSpace: "nowrap", fontWeight: key === "title" ? 600 : 400 }}>{row[key] ?? "—"}</td>)}
                                            {selectedMetrics.map((key) => {
                                                const metric = REPORT_METRICS[key];
                                                const value = metric.money ? formatMoney(row[key], currency) : metric.type === "date" ? formatDate(row[key]) : row[key] ?? "—";
                                                return <td key={`m-${key}`} style={{ padding: "10px", whiteSpace: "nowrap", textAlign: metric.type ? "left" : "right" }}>{key === "productUrl" && row[key] ? <a href={row[key]} target="_blank" rel="noreferrer">View ↗</a> : value}</td>;
                                            })}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>
                    {renderPagination()}
                </s-section>
            </div>
        </s-page>
    );
}

export function ErrorBoundary() {
    return boundary.error();
}

export const headers = (headersArgs) => {
    return boundary.headers(headersArgs);
};
