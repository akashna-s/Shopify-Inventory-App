import React, { useMemo, useState } from "react";
import { useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import * as XLSX from "xlsx";

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

async function fetchAllProducts(admin) {
    const products = [];
    let cursor = null;
    let hasNextPage = true;
    let pages = 0;

    while (hasNextPage && pages < 100) {
        const response = await admin.graphql(
            `#graphql
      query GetProductsForAudit($cursor: String) {
        products(first: 250, after: $cursor, sortKey: TITLE) {
          edges {
            cursor
            node {
              id
              title
              productType
              tags
              handle
              onlineStoreUrl
              createdAt
              status
            }
          }
          pageInfo {
            hasNextPage
          }
        }
      }`,
            { variables: { cursor } },
        );
        const json = await response.json();
        if (json.errors?.length) {
            throw new Error(json.errors[0].message);
        }
        const edges = json.data?.products?.edges || [];
        edges.forEach((edge) => products.push(edge.node));
        hasNextPage = json.data?.products?.pageInfo?.hasNextPage || false;
        cursor = edges[edges.length - 1]?.cursor || null;
        pages += 1;
    }

    return products;
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

async function runShopifyQL(admin, query, limit = SHOPIFYQL_ROW_LIMIT) {
    const limitedQuery = /\bLIMIT\b/i.test(query) ? query : `${query} LIMIT ${limit}`;
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

        console.log(`\n========================================`);
        console.log(`[ShopifyQL Query]: ${limitedQuery}`);
        console.log(`[x-request-id]: ${requestId}`);
        console.log(`[HTTP Response JSON]:\n`, JSON.stringify(json, null, 2));
        console.log(`========================================\n`);

        if (json.errors?.length) {
            return { rows: [], error: json.errors[0].message, truncated: false, requestId, rawJson: json };
        }

        const result = json.data?.shopifyqlQuery;
        if (result?.parseErrors?.length) {
            return { rows: [], error: result.parseErrors.join("; "), truncated: false, requestId, rawJson: json };
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
        return { rows, error: null, truncated: rows.length >= limit, requestId, rawJson: json };
    } catch (err) {
        console.error(`[ShopifyQL Fetch Error]:`, err);
        return { rows: [], error: err.message || "ShopifyQL request failed.", truncated: false, requestId: null, rawJson: null };
    }
}

export const loader = async ({ request }) => {
    const { admin } = await authenticate.admin(request);

    const url = new URL(request.url);
    const filterType = ["day", "week", "month"].includes(url.searchParams.get("filterType"))
        ? url.searchParams.get("filterType")
        : "month";
    const now = new Date();
    const defaultMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const defaultDay = fmtDate(now);

    let dateParam;
    if (filterType === "month") {
        const mp = url.searchParams.get("date") || url.searchParams.get("month");
        dateParam = mp && /^\d{4}-\d{2}$/.test(mp) ? mp : defaultMonth;
    } else {
        const dp = url.searchParams.get("date");
        dateParam = dp && /^\d{4}-\d{2}-\d{2}$/.test(dp) ? dp : defaultDay;
    }

    const { start, end } = dateBoundsFor(filterType, dateParam);
    const month = dateParam; // backward compat
    const displayRange = humanRange(filterType, start, end);

    let products = [];
    let productsError = null;
    try {
        products = await fetchAllProducts(admin);
    } catch (err) {
        productsError = err.message || "Failed to load products.";
    }

    let shopUrl = "";
    let shopCurrency = "USD";
    try {
        const shopResponse = await admin.graphql(
            `#graphql
      query ShopDomainForAudit {
        shop {
          currencyCode
          primaryDomain {
            url
          }
        }
      }`,
        );
        const shopJson = await shopResponse.json();
        shopUrl = shopJson.data?.shop?.primaryDomain?.url || "";
        shopCurrency = shopJson.data?.shop?.currencyCode || "USD";
    } catch {
        // Non-critical — product URLs just fall back to the handle-only link.
    }

    // Session totals + add-to-cart + purchase (checkout) sessions, per product.
    const sessionTotals = await runShopifyQL(
        admin,
        `FROM sessions SHOW sessions, sessions_with_cart_additions, sessions_that_reached_checkout, sessions_that_completed_checkout, conversion_rate WHERE landing_page_type = 'product' GROUP BY landing_page_path SINCE ${start} UNTIL ${end}`,
    );

    // Same session data, broken down by landing page (one-to-many per product).
    const sessionsByLandingPage = await runShopifyQL(
        admin,
        `FROM sessions SHOW sessions GROUP BY landing_page_type, landing_page_path SINCE ${start} UNTIL ${end}`,
    );

    // Revenue for the month, per product.
    const salesTotals = await runShopifyQL(
        admin,
        `FROM sales SHOW total_sales GROUP BY product_id SINCE ${start} UNTIL ${end}`,
    );

    // Inventory levels at the edges of the selected range, per product. All three
    // fields are scoped to SINCE/UNTIL, so day / week / month each report their
    // own opening and closing units rather than a fixed monthly figure.
    const inventoryTotals = await runShopifyQL(
        admin,
        `FROM inventory SHOW starting_inventory_units, ending_inventory_units, first_day_in_inventory GROUP BY product_id SINCE ${start} UNTIL ${end}`,
    );

    // Helper: extract the product handle from a landing_page_path like
    // "/products/my-handle" or "/products/my-handle?variant=123".
    function handleFromPath(path) {
        if (!path) return null;
        const match = path.match(/\/products\/([^/?#]+)/);
        return match ? match[1] : null;
    }

    const landingPageByHandle = {};
    sessionsByLandingPage.rows.forEach((row) => {
        const handle = handleFromPath(row.landing_page_path);
        if (!handle) return;
        if (!landingPageByHandle[handle]) landingPageByHandle[handle] = [];
        landingPageByHandle[handle].push({
            path: row.landing_page_path ?? "Unknown",
            sessions: Number(row.sessions) || 0,
        });
    });

    const sessionByHandle = {};
    sessionTotals.rows.forEach((row) => {
        const handle = handleFromPath(row.landing_page_path);
        if (!handle) return;
        sessionByHandle[handle] = {
            sessions: Number(row.sessions) || 0,
            addToCart: Number(row.sessions_with_cart_additions) || 0,
            reachedCheckout: Number(row.sessions_that_reached_checkout) || 0,
            purchases: Number(row.sessions_that_completed_checkout) || 0,
            conversionRate: Number(row.conversion_rate) || 0,
        };
    });

    const salesByProduct = {};
    salesTotals.rows.forEach((row) => {
        const key = numericId(row.product_id);
        if (!key) return;
        salesByProduct[key] = Number(row.total_sales) || 0;
    });

    const inventoryByProduct = {};
    inventoryTotals.rows.forEach((row) => {
        const key = numericId(row.product_id);
        if (!key) return;
        inventoryByProduct[key] = {
            firstDayInInventory: row.first_day_in_inventory || null,
            startingInventory: row.starting_inventory_units ?? null,
            endingInventory: row.ending_inventory_units ?? null,
        };
    });

    const cleanShopUrl = shopUrl ? shopUrl.replace(/\/$/, "") : "";

    const rows = products.map((product) => {
        const key = numericId(product.id);
        const handle = product.handle || "";
        const session = sessionByHandle[handle] || { sessions: 0, addToCart: 0, reachedCheckout: 0, purchases: 0, conversionRate: 0 };
        const inventory = inventoryByProduct[key] || {
            firstDayInInventory: null,
            startingInventory: null,
            endingInventory: null,
        };

        const prodUrl =
            product.onlineStoreUrl || (cleanShopUrl && product.handle ? `${cleanShopUrl}/products/${product.handle}` : "");

        const landingPages = (landingPageByHandle[handle] || [])
            .sort((a, b) => b.sessions - a.sessions)
            .map((lp) => {
                let fullUrl = lp.path;
                if (cleanShopUrl && lp.path !== "Unknown") {
                    if (lp.path.startsWith("http")) {
                        fullUrl = lp.path;
                    } else {
                        fullUrl = `${cleanShopUrl}${lp.path.startsWith("/") ? "" : "/"}${lp.path}`;
                    }
                }
                const pctNumber = session.sessions > 0 ? (lp.sessions / session.sessions) * 100 : 0;
                const percentage = pctNumber.toFixed(1);

                const isProductUrl = Boolean(
                    product.handle &&
                    (lp.path.includes(`/products/${product.handle}`) || (prodUrl && fullUrl === prodUrl))
                );

                return {
                    path: lp.path,
                    url: fullUrl,
                    sessions: lp.sessions,
                    percentage,
                    isProductUrl,
                };
            });

        const productLandingSessions = landingPages
            .filter((lp) => lp.isProductUrl)
            .reduce((sum, lp) => sum + lp.sessions, 0);

        return {
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
            totalSessions: session.sessions,
            productLandingSessions,
            sessionsByLandingPage: landingPages,
            addToCart: session.addToCart,
            purchases: session.purchases,
            sale: salesByProduct[key] || 0,
        };
    });

    const analyticsQueries = [
        { label: "Sessions / add to cart / purchases", result: sessionTotals },
        { label: "Sessions by landing page", result: sessionsByLandingPage },
        { label: "Sale", result: salesTotals },
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
        sessionTotals: { requestId: sessionTotals.requestId, rowCount: sessionTotals.rows.length, truncated: sessionTotals.truncated, rawJson: sessionTotals.rawJson, error: sessionTotals.error },
        sessionsByLandingPage: { requestId: sessionsByLandingPage.requestId, rowCount: sessionsByLandingPage.rows.length, truncated: sessionsByLandingPage.truncated, rawJson: sessionsByLandingPage.rawJson, error: sessionsByLandingPage.error },
        salesTotals: { requestId: salesTotals.requestId, rowCount: salesTotals.rows.length, truncated: salesTotals.truncated, rawJson: salesTotals.rawJson, error: salesTotals.error },
        inventoryTotals: { requestId: inventoryTotals.requestId, rowCount: inventoryTotals.rows.length, truncated: inventoryTotals.truncated, rawJson: inventoryTotals.rawJson, error: inventoryTotals.error },
    };

    return { rows, month, filterType, dateParam, displayRange, shopCurrency, productsError, analyticsErrors, shopifyqlDebug };
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

export default function ProductsAudit() {
    const { rows, month, filterType, dateParam, displayRange, shopCurrency, productsError, analyticsErrors, shopifyqlDebug } = useLoaderData();
    const [searchParams, setSearchParams] = useSearchParams();
    // Every money value on this page is reported in the store's default currency.
    const currency = shopCurrency || "USD";
    const [searchQuery, setSearchQuery] = useState("");
    const [expandedProductId, setExpandedProductId] = useState(null);
    const [currentPage, setCurrentPage] = useState(1);
    const PAGE_SIZE = 250;

    const filteredRows = useMemo(() => {
        const q = searchQuery.trim().toLowerCase();
        if (!q) return rows;
        const qNumeric = q.replace(/\D/g, "");

        return rows.filter((row) => {
            const title = String(row.title || "").toLowerCase();
            const productId = String(row.productId || "").toLowerCase();
            const productType = String(row.productType || "").toLowerCase();
            const status = String(row.status || "").toLowerCase();
            const tags = Array.isArray(row.tags) ? row.tags : [];

            if (title.includes(q)) return true;
            if (productId.includes(q)) return true;
            if (qNumeric && productId.includes(qNumeric)) return true;
            if (productType.includes(q)) return true;
            if (status.includes(q)) return true;
            if (tags.some((tag) => String(tag).toLowerCase().includes(q))) return true;

            return false;
        });
    }, [rows, searchQuery]);

    const totalPages = Math.ceil(filteredRows.length / PAGE_SIZE) || 1;
    const safePage = Math.min(Math.max(1, currentPage), totalPages);

    const paginatedRows = useMemo(() => {
        const startIdx = (safePage - 1) * PAGE_SIZE;
        return filteredRows.slice(startIdx, startIdx + PAGE_SIZE);
    }, [filteredRows, safePage]);

    // Summary metrics
    const summaryMetrics = useMemo(() => {
        const totalSessions = filteredRows.reduce((s, r) => s + (r.totalSessions || 0), 0);
        const totalAddToCart = filteredRows.reduce((s, r) => s + (r.addToCart || 0), 0);
        const totalPurchases = filteredRows.reduce((s, r) => s + (r.purchases || 0), 0);
        const totalSale = filteredRows.reduce((s, r) => s + (r.sale || 0), 0);
        const convRate = totalSessions > 0 ? ((totalPurchases / totalSessions) * 100).toFixed(1) : "0.0";
        return { totalSessions, totalAddToCart, totalPurchases, totalSale, convRate };
    }, [filteredRows]);

    const navigate = (newFilterType, newDate) => {
        const next = new URLSearchParams(searchParams);
        next.set("filterType", newFilterType);
        next.set("date", newDate);
        next.delete("month");
        setSearchParams(next);
        setCurrentPage(1);
    };

    const handlePrev = () => {
        if (filterType === "day") navigate("day", adjustDay(dateParam, -1));
        else if (filterType === "week") navigate("week", adjustWeek(dateParam, -1));
        else navigate("month", adjustMonth(dateParam, -1));
    };
    const handleNext = () => {
        if (filterType === "day") navigate("day", adjustDay(dateParam, 1));
        else if (filterType === "week") navigate("week", adjustWeek(dateParam, 1));
        else navigate("month", adjustMonth(dateParam, 1));
    };
    const handleToday = () => {
        const now = new Date();
        const today = fmtDate(now);
        const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
        navigate(filterType, filterType === "month" ? thisMonth : today);
    };
    const switchFilter = (newType) => {
        const now = new Date();
        const today = fmtDate(now);
        const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
        navigate(newType, newType === "month" ? thisMonth : today);
    };

    const handleDateInputChange = (e) => {
        const val = e.target.value;
        if (val) navigate(filterType, val);
    };

    const handleSearchChange = (e) => {
        setSearchQuery(e.target.value);
        setCurrentPage(1);
    };

    const exportToExcel = () => {
        const exportRows = filteredRows.map((row) => ({
            "Product ID": row.productId,
            "Product Title": row.title,
            Status: row.status,
            "Product type": row.productType,
            "Product tags": row.tags.join(", "),
            "Product url": row.productUrl,
            "Created at": formatDate(row.createdAt),
            "First day in inventory": formatDate(row.firstDayInInventory),
            [`Starting inventory (${displayRange})`]: row.startingInventory ?? "",
            [`Ending inventory (${displayRange})`]: row.endingInventory ?? "",
            "Total sessions on the product page": row.totalSessions,
            "Product URL Landing Sessions": row.productLandingSessions,
            "Sessions by landing page": row.sessionsByLandingPage
                .map((lp) => `${lp.url} (${lp.sessions} sessions, ${lp.percentage}%)`)
                .join("; "),
            "Add to cart": row.addToCart,
            Purchases: row.purchases,
            [`Sale (${currency})`]: row.sale,
        }));

        const workbook = XLSX.utils.book_new();
        const ws = XLSX.utils.json_to_sheet(exportRows);
        XLSX.utils.book_append_sheet(workbook, ws, "Product Audit");
        XLSX.writeFile(workbook, `Product_Audit_${month}.xlsx`);
    };

    const startIndex = filteredRows.length === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1;
    const endIndex = Math.min(safePage * PAGE_SIZE, filteredRows.length);

    const renderPagination = () => {
        if (filteredRows.length <= PAGE_SIZE) return null;

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

    const tabStyle = (active) => ({
        border: "none",
        background: active ? "#ffffff" : "transparent",
        padding: "7px 16px",
        borderRadius: "6px",
        fontSize: "13px",
        fontWeight: "600",
        color: active ? "#202223" : "#6d7175",
        cursor: "pointer",
        boxShadow: active ? "0 1px 3px rgba(0,0,0,0.12)" : "none",
        transition: "all 0.15s ease",
    });

    const navBtnStyle = {
        padding: "6px 14px",
        border: "1px solid #c9cccf",
        borderRadius: "6px",
        background: "#ffffff",
        cursor: "pointer",
        fontSize: "13px",
        fontWeight: "600",
        color: "#202223",
        transition: "all 0.12s ease",
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
            <div slot="primary-action">
                <button
                    onClick={exportToExcel}
                    style={{
                        backgroundColor: "#107c41",
                        color: "#ffffff",
                        border: "none",
                        borderRadius: "6px",
                        padding: "8px 16px",
                        fontSize: "14px",
                        fontWeight: "600",
                        cursor: "pointer",
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
                    Export to Excel (.xlsx)
                </button>
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

            {shopifyqlDebug && (
                <details style={{ marginBottom: "16px", background: "#f4f6f8", border: "1px solid #c9cccf", borderRadius: "8px", padding: "12px 16px" }}>
                    <summary style={{ cursor: "pointer", fontWeight: "600", fontSize: "13px", color: "#202223" }}>
                        🔍 View ShopifyQL Debug Data
                    </summary>
                    <div style={{ marginTop: "12px", display: "flex", flexDirection: "column", gap: "12px", fontSize: "12px" }}>
                        {Object.entries(shopifyqlDebug).map(([key, val]) => (
                            <div key={key} style={{ background: "#ffffff", padding: "10px", borderRadius: "6px", border: "1px solid #e1e3e5" }}>
                                <div style={{ fontWeight: 600, color: "#005bd3", marginBottom: "4px" }}>
                                    Query: {key}
                                </div>
                                <div style={{ fontFamily: "monospace", color: "#202223", marginBottom: "6px" }}>
                                    <strong>x-request-id:</strong> {val.requestId || "N/A"}
                                    {" · "}
                                    <strong>rows:</strong> {val.rowCount ?? 0}
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

            <s-section>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "14px", marginBottom: "8px" }}>
                    <div style={metricCardStyle}>
                        <span style={{ fontSize: "12px", color: "#6d7175", fontWeight: 500 }}>Total Sessions</span>
                        <span style={{ fontSize: "22px", fontWeight: 700, color: "#202223" }}>{summaryMetrics.totalSessions.toLocaleString()}</span>
                    </div>
                    <div style={metricCardStyle}>
                        <span style={{ fontSize: "12px", color: "#6d7175", fontWeight: 500 }}>Add to Cart</span>
                        <span style={{ fontSize: "22px", fontWeight: 700, color: "#202223" }}>{summaryMetrics.totalAddToCart.toLocaleString()}</span>
                    </div>
                    <div style={metricCardStyle}>
                        <span style={{ fontSize: "12px", color: "#6d7175", fontWeight: 500 }}>Purchases</span>
                        <span style={{ fontSize: "22px", fontWeight: 700, color: "#202223" }}>{summaryMetrics.totalPurchases.toLocaleString()}</span>
                    </div>
                    <div style={metricCardStyle}>
                        <span style={{ fontSize: "12px", color: "#6d7175", fontWeight: 500 }}>Total Sales ({currency})</span>
                        <span style={{ fontSize: "22px", fontWeight: 700, color: "#107c41" }}>{formatMoney(summaryMetrics.totalSale, currency)}</span>
                    </div>
                    <div style={metricCardStyle}>
                        <span style={{ fontSize: "12px", color: "#6d7175", fontWeight: 500 }}>Conversion Rate</span>
                        <span style={{ fontSize: "22px", fontWeight: 700, color: "#005bd3" }}>{summaryMetrics.convRate}%</span>
                    </div>
                </div>
            </s-section>

            <s-section heading="Filter & Timeframe">
                <s-box padding="base" borderRadius="base" style={{ background: "#ffffff", border: "1px solid #e1e3e5", marginBottom: "20px" }}>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "16px", alignItems: "center", justifyContent: "space-between" }}>
                        <div style={{ display: "flex", gap: "4px", background: "#f1f2f4", padding: "4px", borderRadius: "8px" }}>
                            <button type="button" style={tabStyle(filterType === "day")} onClick={() => switchFilter("day")}>📅 Day</button>
                            <button type="button" style={tabStyle(filterType === "week")} onClick={() => switchFilter("week")}>📊 Week</button>
                            <button type="button" style={tabStyle(filterType === "month")} onClick={() => switchFilter("month")}>🗓️ Month</button>
                        </div>

                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                            <button type="button" onClick={handlePrev} style={navBtnStyle}>◀ Prev</button>
                            {filterType === "month" ? (
                                <input type="month" value={dateParam} onChange={handleDateInputChange} style={{ padding: "6px 10px", border: "1px solid #c9cccf", borderRadius: "6px", fontSize: "13px" }} />
                            ) : (
                                <input type="date" value={dateParam} onChange={handleDateInputChange} style={{ padding: "6px 10px", border: "1px solid #c9cccf", borderRadius: "6px", fontSize: "13px" }} />
                            )}
                            <button type="button" onClick={handleNext} style={navBtnStyle}>Next ▶</button>
                            <button type="button" onClick={handleToday} style={{ padding: "6px 12px", border: "none", background: "#e4e5e7", borderRadius: "6px", cursor: "pointer", fontSize: "12px", fontWeight: "600", color: "#202223" }}>Today</button>
                            <span style={{ fontSize: "13px", fontWeight: 600, color: "#202223", marginLeft: "4px" }}>{displayRange}</span>
                        </div>

                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                            <input type="text" placeholder="Search..." value={searchQuery} onChange={handleSearchChange} style={{ padding: "7px 12px", border: "1px solid #c9cccf", borderRadius: "6px", minWidth: "260px", fontSize: "13px" }} />
                            {searchQuery && <button type="button" onClick={() => { setSearchQuery(""); setCurrentPage(1); }} style={{ background: "none", border: "none", color: "#005bd3", cursor: "pointer", fontSize: "13px", fontWeight: "600" }}>Clear</button>}
                        </div>
                    </div>
                </s-box>
            </s-section>

            <s-section heading={`Products (${filteredRows.length})`}>
                {renderPagination()}
                <div style={{ background: "#ffffff", border: "1px solid #e1e3e5", borderRadius: "10px", overflowX: "auto", boxShadow: "0 1px 4px rgba(0,0,0,0.06)" }}>
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
                                    position: "sticky",
                                    top: 0,
                                    zIndex: 2,
                                }}>
                                    {[
                                        { label: "#", width: "44px" },
                                        { label: "Product ID", width: "110px" },
                                        { label: "Title", width: "200px" },
                                        { label: "Status", width: "80px" },
                                        { label: "Type", width: "100px" },
                                        { label: "Tags", width: "120px" },
                                        { label: "URL", width: "56px" },
                                        { label: "Created At", width: "110px" },
                                        { label: "First Day in Inventory", width: "120px" },
                                        { label: "Starting Inventory", width: "100px" },
                                        { label: "Ending Inventory", width: "100px" },
                                        { label: "Sessions", width: "76px" },
                                        { label: "Landing Pages", width: "100px" },
                                        { label: "Add to Cart", width: "76px" },
                                        { label: "Purchases", width: "76px" },
                                        { label: `Sale (${currency})`, width: "90px" },
                                    ].map((col) => (
                                        <th key={col.label} style={{
                                            padding: "11px 10px",
                                            fontSize: "11px",
                                            fontWeight: 700,
                                            textTransform: "uppercase",
                                            letterSpacing: "0.5px",
                                            color: "#5c5f62",
                                            whiteSpace: "nowrap",
                                            minWidth: col.width,
                                        }}>
                                            {col.label}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {paginatedRows.map((row, idx) => {
                                    const isExpanded = expandedProductId === row.productId;
                                    const rowNum = (safePage - 1) * PAGE_SIZE + idx + 1;
                                    const stripe = idx % 2 === 0 ? "#ffffff" : "#fafbfc";

                                    const statusColors = {
                                        ACTIVE: { bg: "#e3f1df", fg: "#0d5e27" },
                                        DRAFT: { bg: "#fff4e5", fg: "#9c5b00" },
                                        ARCHIVED: { bg: "#e4e5e7", fg: "#4a4a4a" },
                                    };
                                    const sc = statusColors[row.status] || { bg: "#e4e5e7", fg: "#4a4a4a" };

                                    return (
                                        <React.Fragment key={row.productId}>
                                            <tr style={{
                                                borderBottom: "1px solid #f1f2f4",
                                                background: stripe,
                                                transition: "background 0.1s ease",
                                            }}
                                            onMouseEnter={(e) => e.currentTarget.style.background = "#eef4fb"}
                                            onMouseLeave={(e) => e.currentTarget.style.background = stripe}
                                            >
                                                <td style={{ padding: "10px", color: "#8c9196", fontSize: "12px", textAlign: "center" }}>{rowNum}</td>
                                                <td style={{ padding: "10px", fontFamily: "monospace", fontSize: "12px", color: "#6d7175" }}>{row.productId}</td>
                                                <td style={{ padding: "10px", fontWeight: 600, color: "#202223", maxWidth: "220px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={row.title}>{row.title}</td>
                                                <td style={{ padding: "10px" }}>
                                                    <span style={{
                                                        display: "inline-block",
                                                        padding: "3px 10px",
                                                        borderRadius: "12px",
                                                        fontSize: "10px",
                                                        fontWeight: 700,
                                                        textTransform: "uppercase",
                                                        letterSpacing: "0.3px",
                                                        background: sc.bg,
                                                        color: sc.fg,
                                                    }}>
                                                        {row.status || "—"}
                                                    </span>
                                                </td>
                                                <td style={{ padding: "10px", color: "#4a4a4a", fontSize: "12px" }}>{row.productType || "—"}</td>
                                                <td style={{ padding: "10px", fontSize: "12px", color: "#6d7175", maxWidth: "140px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={row.tags.join(", ")}>{row.tags.join(", ") || "—"}</td>
                                                <td style={{ padding: "10px" }}>
                                                    {row.productUrl ? (
                                                        <a href={row.productUrl} target="_blank" rel="noreferrer" style={{
                                                            color: "#005bd3",
                                                            textDecoration: "none",
                                                            fontSize: "12px",
                                                            fontWeight: 600,
                                                            display: "inline-flex",
                                                            alignItems: "center",
                                                            gap: "3px",
                                                        }}>
                                                            View ↗
                                                        </a>
                                                    ) : "—"}
                                                </td>
                                                <td style={{ padding: "10px", fontSize: "12px", color: "#4a4a4a", whiteSpace: "nowrap" }}>{formatDate(row.createdAt)}</td>
                                                <td style={{ padding: "10px", fontSize: "12px", color: "#4a4a4a", whiteSpace: "nowrap" }}>{formatDate(row.firstDayInInventory)}</td>
                                                <td style={{ padding: "10px", fontWeight: 600, textAlign: "right" }}>{row.startingInventory ?? "—"}</td>
                                                <td style={{ padding: "10px", fontWeight: 600, textAlign: "right" }}>{row.endingInventory ?? "—"}</td>
                                                <td style={{ padding: "10px", fontWeight: 600, textAlign: "right", color: row.totalSessions > 0 ? "#202223" : "#8c9196" }}>{row.totalSessions}</td>
                                                <td style={{ padding: "10px" }}>
                                                    {row.sessionsByLandingPage.length === 0 ? (
                                                        <span style={{ color: "#8c9196" }}>—</span>
                                                    ) : (
                                                        <button
                                                            type="button"
                                                            onClick={() => setExpandedProductId(isExpanded ? null : row.productId)}
                                                            style={{
                                                                background: isExpanded ? "#202223" : "#f1f2f4",
                                                                color: isExpanded ? "#ffffff" : "#202223",
                                                                border: "none",
                                                                borderRadius: "6px",
                                                                padding: "4px 10px",
                                                                fontSize: "12px",
                                                                fontWeight: 600,
                                                                cursor: "pointer",
                                                                transition: "all 0.12s ease",
                                                            }}
                                                        >
                                                            {row.sessionsByLandingPage.length} page{row.sessionsByLandingPage.length === 1 ? "" : "s"} {isExpanded ? "▲" : "▼"}
                                                        </button>
                                                    )}
                                                </td>
                                                <td style={{ padding: "10px", textAlign: "right", color: row.addToCart > 0 ? "#202223" : "#8c9196" }}>{row.addToCart}</td>
                                                <td style={{ padding: "10px", textAlign: "right", color: row.purchases > 0 ? "#202223" : "#8c9196" }}>{row.purchases}</td>
                                                <td style={{ padding: "10px", fontWeight: 700, textAlign: "right", color: row.sale > 0 ? "#107c41" : "#8c9196" }}>
                                                    {formatMoney(row.sale, currency)}
                                                </td>
                                            </tr>
                                            {isExpanded && (
                                                <tr>
                                                    <td colSpan="16" style={{ padding: "16px 20px", background: "#f4f6f8", borderBottom: "2px solid #e1e3e5" }}>
                                                        <div style={{ fontWeight: 700, marginBottom: "10px", fontSize: "13px", color: "#202223" }}>
                                                            🔗 Landing Pages for <em>{row.title}</em>
                                                        </div>
                                                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", background: "#ffffff", border: "1px solid #e1e3e5", borderRadius: "8px", overflow: "hidden" }}>
                                                            <thead>
                                                                <tr style={{ background: "#f7f8f9", textAlign: "left" }}>
                                                                    <th style={{ padding: "8px 12px", fontSize: "11px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.4px", color: "#5c5f62" }}>URL</th>
                                                                    <th style={{ padding: "8px 12px", fontSize: "11px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.4px", color: "#5c5f62" }}>Path</th>
                                                                    <th style={{ padding: "8px 12px", fontSize: "11px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.4px", color: "#5c5f62" }}>Sessions</th>
                                                                    <th style={{ padding: "8px 12px", fontSize: "11px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.4px", color: "#5c5f62" }}>Share</th>
                                                                    <th style={{ padding: "8px 12px", fontSize: "11px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.4px", color: "#5c5f62" }}>Type</th>
                                                                </tr>
                                                            </thead>
                                                            <tbody>
                                                                {row.sessionsByLandingPage.map((lp) => (
                                                                    <tr key={lp.url + lp.path} style={{ borderBottom: "1px solid #f1f2f4" }}>
                                                                        <td style={{ padding: "8px 12px", wordBreak: "break-all" }}>
                                                                            {lp.url && lp.url !== "Unknown" ? (
                                                                                <a href={lp.url} target="_blank" rel="noreferrer" style={{ color: "#005bd3", textDecoration: "none" }}>
                                                                                    {lp.url}
                                                                                </a>
                                                                            ) : "—"}
                                                                        </td>
                                                                        <td style={{ padding: "8px 12px", color: "#6d7175", fontFamily: "monospace", fontSize: "11px" }}>{lp.path}</td>
                                                                        <td style={{ padding: "8px 12px", fontWeight: 700 }}>{lp.sessions}</td>
                                                                        <td style={{ padding: "8px 12px" }}>
                                                                            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                                                                <div style={{ width: "60px", height: "6px", background: "#e1e3e5", borderRadius: "3px", overflow: "hidden" }}>
                                                                                    <div style={{ width: `${Math.min(100, Number(lp.percentage))}%`, height: "100%", background: "#005bd3", borderRadius: "3px" }} />
                                                                                </div>
                                                                                <span style={{ fontSize: "12px", fontWeight: 600 }}>{lp.percentage}%</span>
                                                                            </div>
                                                                        </td>
                                                                        <td style={{ padding: "8px 12px" }}>
                                                                            {lp.isProductUrl ? (
                                                                                <span style={{ padding: "3px 8px", borderRadius: "6px", background: "#e3f1df", color: "#0d5e27", fontSize: "10px", fontWeight: 700, textTransform: "uppercase" }}>
                                                                                    Product
                                                                                </span>
                                                                            ) : (
                                                                                <span style={{ padding: "3px 8px", borderRadius: "6px", background: "#f1f2f4", color: "#6d7175", fontSize: "10px", fontWeight: 600, textTransform: "uppercase" }}>
                                                                                    Other
                                                                                </span>
                                                                            )}
                                                                        </td>
                                                                    </tr>
                                                                ))}
                                                            </tbody>
                                                        </table>
                                                    </td>
                                                </tr>
                                            )}
                                        </React.Fragment>
                                    );
                                })}
                            </tbody>
                        </table>
                    )}
                </div>
                {renderPagination()}
            </s-section>
        </s-page>
    );
}

export function ErrorBoundary() {
    return boundary.error();
}

export const headers = (headersArgs) => {
    return boundary.headers(headersArgs);
};
