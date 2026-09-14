const fs = require("fs");
const path = require("path");
const {
  AlignmentType, BorderStyle, Document, Footer, HeadingLevel, PageBreak,
  PageNumber, Packer, Paragraph, ShadingType, Table, TableCell, TableRow,
  TextRun, WidthType,
} = require("C:/Users/dell/Desktop/shopapp/prd-tools/node_modules/docx");

const OUT = path.resolve(__dirname, "../docs/Audit_Bot_Current_State_PRD_2026-09-14.docx");
const NAVY = "182A3A";
const GREEN = "008060";
const BLUE = "005BD3";
const LIGHT = "F1F2F4";
const PALE = "F7F7F8";
const BORDER = "D2D5D8";
const TEXT = "303030";
const MUTED = "616161";
const WARN = "FFF4E5";
const RED = "B42318";

const border = { style: BorderStyle.SINGLE, size: 1, color: BORDER };
const borders = { top: border, bottom: border, left: border, right: border };
const children = [];

const bullet = (text, level = 0) => new Paragraph({
  numbering: { reference: "bullets", level },
  spacing: { after: 80 },
  children: [new TextRun({ text, color: TEXT, size: 20 })],
});
const p = (text, opts = {}) => new Paragraph({
  spacing: { after: opts.after ?? 120, line: 290 },
  alignment: opts.alignment,
  children: [new TextRun({ text, color: opts.color || TEXT, size: opts.size || 21, bold: opts.bold })],
});
const h1 = (text) => new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 140 }, children: [new TextRun({ text, color: NAVY, bold: true })] });
const h2 = (text) => new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 180, after: 100 }, children: [new TextRun({ text, color: GREEN, bold: true })] });
const h3 = (text) => new Paragraph({ heading: HeadingLevel.HEADING_3, spacing: { before: 140, after: 80 }, children: [new TextRun({ text, color: TEXT, bold: true })] });
const pageBreak = () => new Paragraph({ children: [new PageBreak()] });
const badge = (text, color = GREEN) => new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text, bold: true, color, size: 19 })] });

function cell(text, width, options = {}) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    shading: options.fill ? { type: ShadingType.CLEAR, fill: options.fill } : undefined,
    borders,
    margins: { top: 110, bottom: 110, left: 120, right: 120 },
    children: [new Paragraph({
      children: [new TextRun({ text: String(text), bold: options.bold, color: options.color || TEXT, size: options.size || 19 })],
      spacing: { after: 0, line: 250 },
    })],
  });
}

function table(headers, rows, widths) {
  const total = widths.reduce((a, b) => a + b, 0);
  return new Table({
    width: { size: total, type: WidthType.DXA },
    columnWidths: widths,
    rows: [
      new TableRow({ tableHeader: true, children: headers.map((x, i) => cell(x, widths[i], { fill: NAVY, bold: true, color: "FFFFFF" })) }),
      ...rows.map((row, ri) => new TableRow({ children: row.map((x, i) => cell(x, widths[i], { fill: ri % 2 ? "FFFFFF" : PALE })) })),
    ],
  });
}

function callout(title, body, fill = "EAF4FF") {
  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: [9360],
    rows: [new TableRow({ children: [new TableCell({
      width: { size: 9360, type: WidthType.DXA }, borders,
      shading: { type: ShadingType.CLEAR, fill },
      margins: { top: 150, bottom: 150, left: 180, right: 180 },
      children: [
        new Paragraph({ spacing: { after: 70 }, children: [new TextRun({ text: title, bold: true, color: NAVY, size: 21 })] }),
        new Paragraph({ spacing: { after: 0, line: 280 }, children: [new TextRun({ text: body, color: TEXT, size: 20 })] }),
      ],
    })] })],
  });
}

function flow(steps) {
  const out = [];
  for (let i = 0; i < steps.length; i++) {
    out.push(new Table({ width: { size: 7600, type: WidthType.DXA }, columnWidths: [7600], alignment: AlignmentType.CENTER, rows: [new TableRow({ children: [new TableCell({ width: { size: 7600, type: WidthType.DXA }, borders, shading: { type: ShadingType.CLEAR, fill: i === 0 ? "E3F1DF" : "F7F7F8" }, margins: { top: 120, bottom: 120, left: 160, right: 160 }, children: [badge(`${i + 1}. ${steps[i]}`, i === 0 ? GREEN : NAVY)] })] })] }));
    if (i < steps.length - 1) out.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 30, after: 30 }, children: [new TextRun({ text: "↓", bold: true, color: BLUE, size: 28 })] }));
  }
  return out;
}

// Cover
children.push(
  new Paragraph({ spacing: { before: 1450, after: 180 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: "AUDIT BOT", bold: true, color: GREEN, size: 25, characterSpacing: 120 })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 180 }, children: [new TextRun({ text: "Current-State Product Requirements Document", bold: true, color: NAVY, size: 42 })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 500 }, children: [new TextRun({ text: "How the app works, how Shopify data is fetched, and how to improve speed and reliability", color: MUTED, size: 24 })] }),
  callout("Document purpose", "This document explains the live implementation in simple language. It separates what already exists from recommended future improvements, so product and engineering decisions can be made without confusing proposals with current behaviour."),
  new Paragraph({ spacing: { before: 700 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: "Prepared from the codebase on 14 September 2026", color: MUTED, size: 20 })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "Status: Current-state PRD + optimization decision guide", color: MUTED, size: 20 })] }),
  pageBreak(),
);

children.push(h1("Document control"));
children.push(table(["Item", "Value"], [
  ["Product", "Audit Bot — embedded Shopify analytics application"],
  ["Primary users", "Shopify merchants, DTC founders, e-commerce operators and analysts"],
  ["Current reporting pages", "Product Audit and New Arrival Analysis"],
  ["Data sources", "Shopify Admin GraphQL, ShopifyQL analytics, local Prisma/SQLite cache"],
  ["Reporting availability", "Last 18 full calendar months through the allowed current date"],
  ["Document scope", "Current behaviour, data lineage, calculations, risks and recommended performance roadmap"],
], [2600, 6760]));

children.push(h1("Contents"));
[
  "1. Product vision and users", "2. Current application scope", "3. System architecture",
  "4. Shared data foundations", "5. Product Audit workflow", "6. New Arrival Analysis workflow",
  "7. Metric and calculation rules", "8. Current loading and error controls",
  "9. Root-cause analysis", "10. Optimization options and consequences",
  "11. Recommended implementation roadmap", "12. Acceptance criteria and operating checklist",
].forEach((x) => children.push(bullet(x)));

children.push(pageBreak(), h1("1. Product vision and users"));
children.push(p("Audit Bot helps merchants inspect product-level inventory, sales, landing sessions and new-arrival cohort performance without manually exporting Shopify reports into spreadsheets."));
children.push(h2("Primary jobs to be done"));
children.push(bullet("Understand how each product performed during a chosen date range."));
children.push(bullet("Compare sales, orders, traffic and inventory at product level."));
children.push(bullet("Identify when products entered a new-arrival cohort and measure their performance over later periods."));
children.push(bullet("Break cohort performance down by Product Type or Product Tag."));
children.push(bullet("Export report-ready data in CSV, JSONL or XML formats."));
children.push(h2("Product principles"));
children.push(bullet("Use the store's default currency for every money value."));
children.push(bullet("Show a clear loading state instead of leaving stale data visible."));
children.push(bullet("Warn when Shopify returns incomplete data rather than silently presenting it as complete."));
children.push(bullet("Keep calculations understandable and document the business meaning of each metric."));

children.push(h1("2. Current application scope"));
children.push(table(["Area", "What exists now", "What it does not do"], [
  ["Public landing page", "Introduces the app and routes merchants into Shopify authentication.", "It does not fetch analytics report data."],
  ["In-app Home", "Provides navigation to Product Audit and New Arrival Analysis.", "The former Order Details report has been removed."],
  ["Product Audit", "Custom date report for product catalog, inventory, landing sessions, orders and sales metrics; configurable dimensions, filters, sorting and export.", "Product page views and product sessions were intentionally removed because they were not reliable enough."],
  ["New Arrival Analysis", "Monthly or weekly cohort matrix plus product-level cohort details; classification by Product Type or Product Tag.", "Category tables are not prepared automatically; they load when opened."],
  ["Additional page", "A basic authenticated placeholder route remains.", "No major reporting workflow is currently defined there."],
], [1900, 4050, 3410]));

children.push(pageBreak(), h1("3. System architecture"));
children.push(...flow([
  "Merchant opens the embedded app inside Shopify Admin",
  "Shopify authenticates the store and supplies an Admin API session",
  "React Router loader runs on the app server",
  "Server reads reusable catalog/analytics cache and requests missing Shopify data",
  "Server matches product IDs and handles, then calculates report rows",
  "Browser receives report data and renders filters, totals, table and export controls",
]));
children.push(h2("Technology in plain language"));
children.push(table(["Component", "Simple explanation"], [
  ["React Router 7", "Runs page loaders on the server and renders the embedded user interface."],
  ["Shopify Admin GraphQL", "Fetches product master data such as ID, title, type, tags, handle, status, image and created date."],
  ["ShopifyQL", "Fetches analytics tables for inventory, sales and sessions."],
  ["Prisma + SQLite", "Stores Shopify sessions and reusable report/cache records."],
  ["App Bridge / Shopify components", "Keeps the app embedded and visually aligned with Shopify Admin."],
], [2500, 6860]));

children.push(h1("4. Shared data foundations"));
children.push(h2("4.1 Product catalog"));
children.push(p("The catalog supplies descriptive fields that analytics rows often do not contain reliably: Product ID, title, type, tags, handle, status, image and created date."));
children.push(...flow([
  "Check ProductCatalogCache for this shop",
  "If cache exists, return it immediately",
  "If older than 6 hours, refresh in the background while serving stale cache",
  "Refresh with Shopify Bulk Operation; fall back to pages of 250 products if bulk fails",
  "Store refreshed catalog in SQLite for later requests",
]));
children.push(callout("Why the refresh time can look old", "A cache older than six hours is intentionally served immediately so the report does not wait for the entire catalog download. A background refresh begins, so the displayed timestamp can remain old until that refresh completes and the page is opened again.", WARN));

children.push(h2("4.2 Analytics cache"));
children.push(p("Each analytics cache key contains the shop, dataset name, start date and end date. Only successful, non-truncated results are saved."));
children.push(bullet("Historical ranges older than the three-day finalization grace period can be cached."));
children.push(bullet("Recent ranges are fetched live because Shopify can still update them."));
children.push(bullet("A cache hit avoids the ShopifyQL request; a miss runs the query and saves it if complete."));
children.push(bullet("Different query shapes use different dataset keys. Product Audit daily inventory cannot automatically replace New Arrival monthly inventory without a deliberate shared data model."));

children.push(h2("4.3 Error and completeness handling"));
children.push(bullet("ShopifyQL queries have a 100,000-row limit."));
children.push(bullet("Temporary errors such as throttling, timeout, 502, 503 and 504 are retried up to three times with increasing pauses."));
children.push(bullet("Errors do not crash the full report. The page can show available sections plus an incomplete-data warning."));
children.push(bullet("Debug details show request IDs, rows, time, attempts, cache status and truncation information."));

children.push(pageBreak(), h1("5. Product Audit workflow"));
children.push(h2("5.1 User experience"));
children.push(bullet("Choose a custom range within the allowed 18-month window."));
children.push(bullet("Apply the range; the selected dates appear immediately and the old report body is replaced by a loader."));
children.push(bullet("Choose dimensions such as Product ID, Title, Status, Type, Tags, Month, Week or Day."));
children.push(bullet("Choose metrics, reorder them, filter values and sort columns."));
children.push(bullet("View 50 rows per browser page or export the current page/all filtered results."));

children.push(h2("5.2 Queries currently run"));
children.push(table(["Dataset", "ShopifyQL shape", "Purpose"], [
  ["Landing sessions", "Sessions grouped by day and landing page path where landing page type is Product.", "Maps a product landing URL/handle to landing sessions and checkout-session metrics."],
  ["Sales breakdown", "Sales grouped by day and product ID.", "Orders, quantities, reversals, gross/net/total sales, discounts, shipping, fees and taxes."],
  ["Unique order total", "Sales orders without product grouping.", "Selected-metric total counts a store order once even when it contains multiple products."],
  ["Inventory", "Starting inventory, ending inventory and first day in inventory grouped by day and product ID.", "Supports range boundaries and optional Month/Week/Day grouping."],
], [1950, 4050, 3360]));

children.push(h2("5.3 Inventory chunking"));
children.push(p("Inventory is the largest dataset. The selected range is divided into non-overlapping seven-day pieces. Up to two pieces start together. If a piece reaches 100,000 rows, it is divided again until complete or until one day remains."));
children.push(...flow([
  "Split selected range into seven-day chunks",
  "Read cached historical chunks; fetch missing/live chunks",
  "If a chunk reaches 100,000 rows, divide it into smaller chunks",
  "Pause between live requests to reduce throttling",
  "After normal retries, wait and replay only rate-limited chunks sequentially",
  "Combine all successful daily rows",
]));
children.push(callout("Important limitation", "Chunking prevents a long range from hitting 100,000 rows as one giant response. It does not remove Shopify's request-rate limit. A very long uncached range can still require many requests and therefore needs pacing, recovery and eventually a stronger storage design.", WARN));

children.push(h2("5.4 Server matching and browser processing"));
children.push(bullet("Product IDs connect sales and inventory rows to the catalog."));
children.push(bullet("Landing-page handles connect session paths to catalog products."));
children.push(bullet("The server creates product-day source rows and sends them to the browser."));
children.push(bullet("The browser currently groups those rows by selected Month, Week, Day and product dimensions using a streaming single-pass calculation."));
children.push(bullet("Changing a dimension shows a loader before regrouping to avoid an apparently frozen screen."));

children.push(pageBreak(), h1("6. New Arrival Analysis workflow"));
children.push(h2("6.1 User experience"));
children.push(bullet("Choose Month or Week grouping. Month is the default."));
children.push(bullet("Choose Product Type or Product Tag classification. Product Type is the default."));
children.push(bullet("View the Overall cohort matrix first."));
children.push(bullet("Category names are listed in collapsed form. A category is calculated only when clicked, then retained in browser memory for instant reopening."));
children.push(bullet("Open Cohort Details for product-level values, search, filters, sorting, density and export."));

children.push(h2("6.2 Monthly fetch"));
children.push(p("For each selected month, the server runs four period-level ShopifyQL queries in parallel: product inventory, product sales/orders, total store sales and product landing sessions. Up to two months are processed concurrently."));
children.push(h2("6.3 Weekly fetch"));
children.push(p("Selected weeks are grouped into batches of up to seven weeks. Each batch runs four queries grouped by week. The result is then separated into individual week rows in the app. If a batch reaches the row limit, it is divided into smaller batches."));
children.push(h2("6.4 First-cohort lookback"));
children.push(p("The report checks from the first day of the month two months before the selected start through the day immediately before the selected start. A product found there is moved to the first displayed cohort only if it also becomes active somewhere inside the selected report range."));
children.push(p("Example: range starts 15 August 2025. The lookback is 1 June–14 August 2025. If Product A was active in July and becomes active again in January inside the selected range, it belongs to the August first cohort. If it never becomes active inside the range, it is excluded."));

children.push(h2("6.5 Cohort calculation"));
children.push(...flow([
  "Combine catalog fields with inventory, sales, orders and landing sessions for every period",
  "Mark a product active when starting inventory > 0, ending inventory > 0, or total sales > 0",
  "Assign the earliest active selected period as launch cohort",
  "Override to first cohort only when lookback and in-range activity rules both match",
  "Calculate Overall matrix and Product Type/Tag category list",
  "Calculate category matrix on click; keep loaded result in browser memory",
]));
children.push(callout("Tag duplication rule", "A product counts once in Overall. If it has multiple tags, it appears in every matching tag category. Therefore, adding category totals together can double-count the same product and should not be used as an Overall total.", WARN));

children.push(pageBreak(), h1("7. Metric and calculation rules"));
children.push(h2("7.1 Product Audit key metrics"));
children.push(table(["Metric", "Current meaning"], [
  ["Starting inventory", "Inventory value from the earliest available daily row in the selected group."],
  ["Ending inventory", "Inventory value from the latest available daily row in the selected group."],
  ["First day in inventory", "Shopify's first_day_in_inventory value returned within the selected ShopifyQL result; earliest value is retained when grouped."],
  ["Landing sessions", "Sessions whose journey began on that product's landing-page path."],
  ["Orders by product", "Orders containing that product. One multi-product order contributes one order to each included product."],
  ["Unique orders total", "Store-level order count without product grouping; the same multi-product order counts once."],
  ["Net items sold", "Shopify net item quantity after reversals."],
  ["Total sales", "Shopify total_sales in the store's default currency."],
], [2500, 6860]));

children.push(h2("7.2 New Arrival matrix formulas"));
children.push(table(["Metric", "Simple definition / formula"], [
  ["NA SKUs", "Active distinct cohort products in that period."],
  ["NA SKU %", "Active cohort products ÷ total products launched in that cohort × 100."],
  ["NA SKU % (Total)", "Active cohort products ÷ all active store products in that period × 100."],
  ["NA Inventory", "Ending inventory in launch period; starting inventory in later periods."],
  ["NA Inventory %", "Cohort inventory ÷ total store inventory in that period × 100."],
  ["NA Sales", "Sum of total_sales generated by cohort products."],
  ["NA Sales %", "Cohort total_sales ÷ store total_sales in that period × 100."],
  ["Landing Sessions", "Sessions that began on a PDP belonging to the cohort."],
  ["Orders", "Product-level orders summed for the cohort."],
  ["CR %", "Orders ÷ landing sessions × 100. Directional only, because sessions that started elsewhere are not included."],
], [2400, 6960]));
children.push(callout("Why first-cohort NA SKU % can be below 100%", "Lookback products can be assigned to the first cohort even if they are inactive during the first displayed period. They must become active later inside the selected range, but the numerator for the first period counts only products active in that period."));

children.push(h1("8. Current loading and error controls"));
children.push(table(["Control", "Already implemented", "Benefit"], [
  ["Parallel independent queries", "Catalog, shop info and analytics requests start together where safe.", "Total wait approaches the slowest branch instead of the sum of every branch."],
  ["Catalog stale-while-refresh", "Serve existing catalog, refresh after six hours in background.", "Fast initial catalog access."],
  ["Historical analytics cache", "Successful finalized ranges stored by shop/dataset/range.", "Repeat historical ranges avoid ShopifyQL."],
  ["Automatic query retry", "Up to three attempts for temporary failures with increasing waits.", "Recovers brief throttles/timeouts."],
  ["Inventory date chunking", "Seven-day chunks, recursive split on 100k limit.", "Reduces incomplete inventory responses."],
  ["Inventory recovery passes", "Paced live requests; failed rate-limited chunks retried after shared cooldowns.", "Recovers longer throttle windows without repeating successful chunks."],
  ["Loading screens", "Old report body hidden during date/dimension changes.", "Prevents users reading stale data as new data."],
  ["Streaming browser grouping", "Single pass instead of retaining and repeatedly sorting group arrays.", "Reduces browser freeze risk."],
  ["Category on demand", "New Arrival category matrix runs only on click and stays in memory.", "Faster Overall first display."],
], [2150, 4400, 2810]));

children.push(pageBreak(), h1("9. Root-cause analysis: why reports can still be slow"));
children.push(table(["Root cause", "What happens", "Visible symptom"], [
  ["Too many raw Product Audit rows", "4,003 products × 72 days can approach 288,216 rows before sessions/sales matching.", "Long server response, large JSON transfer and expensive browser work."],
  ["Inventory request multiplication", "A long range becomes many seven-day requests; large chunks may split again.", "Long loading time and Shopify rate limiting."],
  ["Live recent dates", "Recent ranges bypass analytics cache by design.", "Repeated requests for the current period still call Shopify."],
  ["Exact-range cache keys", "A cached Jul 1–31 result does not automatically satisfy Jul 1–Aug 15 unless matching chunks exist.", "Overlapping custom ranges can repeat work."],
  ["Concurrent report families", "Landing sessions, sales, unique orders and inventory begin together.", "Fast when budget is available; throttling risk when inventory also creates many calls."],
  ["Browser receives more than it displays", "Only 50 rows are visible, but source rows for the full range are sent for client filtering/grouping/export.", "Memory pressure and Page Unresponsive warnings."],
  ["SQLite production scaling", "A local SQLite file is simple but not ideal for multiple server instances or very large analytics history.", "Deployment limits, lock contention and harder horizontal scaling."],
  ["Shopify service conditions", "Throttling or temporary errors can happen even with correct code.", "Incomplete-data warning after retries."],
], [2350, 4550, 2460]));

children.push(h1("10. Optimization options and consequences"));
children.push(h2("Option A — Server-side aggregation (highest immediate UI impact)"));
children.push(p("Today Product Audit sends daily source rows to the browser so the browser can build Month/Week/Day groups. Server-side aggregation means the server performs that grouping first and sends only the final grouped rows required for the chosen dimensions."));
children.push(p("Example: instead of sending about 288,000 product-day rows for 4,003 products over 72 days, a product-only view can send about 4,003 rows. A product-by-month view may send about 12,000 rows."));
children.push(bullet("Benefit: far smaller response, less memory, fewer Page Unresponsive incidents, faster table rendering."));
children.push(bullet("Consequence: changing a dimension requires a server request instead of instant local regrouping."));
children.push(bullet("Implementation: send selected dimensions/filters/sort/page in URL; group on server; return summary plus one page."));
children.push(bullet("Export: run a server-side export job using the same filters rather than relying on browser-held rows."));

children.push(h2("Option B — Server-side pagination and filtering"));
children.push(p("Return only the 50 rows currently visible, plus total row count and summary. Filters and sorting run before pagination on the server."));
children.push(bullet("Benefit: browser workload becomes almost constant even for very large stores."));
children.push(bullet("Consequence: every filter, sort or page change makes a small server request."));
children.push(bullet("Requirement: summary totals must be calculated separately so they represent all filtered rows, not only the current page."));

children.push(h2("Option C — Normalize daily analytics into a database"));
children.push(p("Store one cleaned row per shop, product and day. Shopify is queried once for missing/fresh dates; all reports read and aggregate the local database."));
children.push(bullet("Benefit: custom ranges, Month/Week/Day views and New Arrival reports reuse the same daily foundation."));
children.push(bullet("Benefit: Shopify timeouts and rate limits stop being part of normal page opening."));
children.push(bullet("Consequence: database storage, background jobs, monitoring, data correction and operating cost increase."));
children.push(bullet("Recommended database: managed PostgreSQL rather than SQLite for a production multi-store SaaS."));
children.push(callout("This is different from Shopify Bulk Analytics access", "The app can build its own daily store using the ShopifyQL access it already has. It does not require a special new Shopify bulk analytics API, but it does require scheduled/background processing and production database capacity.", "EAF4FF"));

children.push(h2("Option D — Incremental and canonical cache chunks"));
children.push(p("Cache analytics in fixed daily or weekly blocks instead of arbitrary user-selected ranges. A custom range is assembled from reusable blocks, with only uncovered boundary dates fetched live."));
children.push(bullet("Benefit: overlapping ranges reuse much more work."));
children.push(bullet("Benefit: lower cost than a complete warehouse and compatible with the current architecture."));
children.push(bullet("Consequence: partial first/last periods require careful merging; current-period blocks need refresh/expiry rules."));

children.push(h2("Option E — Global ShopifyQL request scheduler"));
children.push(p("Use one per-shop request queue shared by all report queries. The queue controls concurrency, pauses after throttling and honors any retry-after signal when available."));
children.push(bullet("Benefit: Product Audit and New Arrival requests cannot accidentally overwhelm the same store's ShopifyQL budget."));
children.push(bullet("Consequence: an uncached report may take slightly longer in the happy path, but succeeds more reliably."));
children.push(bullet("Current recovery is local to Product Audit inventory; a global scheduler would protect every ShopifyQL dataset."));

children.push(h2("Option F — Background report jobs"));
children.push(p("For heavy custom ranges or exports, create a job, show progress, store the completed result and notify the page when ready."));
children.push(bullet("Benefit: web requests do not time out; users can leave and return."));
children.push(bullet("Consequence: requires a job queue/worker, job status storage and cleanup policy."));

children.push(h2("Option G — Precompute common summaries"));
children.push(p("Prepare common Month and Week totals after data becomes available, so normal report openings read ready-made summaries."));
children.push(bullet("Benefit: near-instant common views."));
children.push(bullet("Consequence: more stored rows and background processing; custom dimensions may still need live aggregation."));

children.push(h2("Option H — Reduce debug payload in normal use"));
children.push(p("Keep request IDs, timing and status, but do not return large raw debug structures unless debug mode is explicitly enabled."));
children.push(bullet("Benefit: smaller response and cleaner UI."));
children.push(bullet("Consequence: support staff must enable debug mode when deeper evidence is needed."));

children.push(pageBreak(), h1("11. Optimization decision matrix"));
children.push(table(["Option", "Speed gain", "Timeout/rate-limit gain", "Complexity", "Cost impact", "Recommendation"], [
  ["Server-side aggregation", "Very high", "Medium", "Medium", "Low–medium", "Do first"],
  ["Server pagination/filter/sort", "Very high", "Low", "Medium", "Low–medium", "Do with aggregation"],
  ["Canonical cache chunks", "High on repeat/overlap", "High", "Medium", "Low–medium", "Next"],
  ["Global request scheduler", "Neutral/slightly slower", "Very high", "Medium", "Low", "Next"],
  ["Daily analytics database", "Very high", "Very high", "High", "Medium–high", "Best long-term scale"],
  ["Background report jobs", "High perceived reliability", "Very high", "High", "Medium", "For heavy ranges/exports"],
  ["Precomputed summaries", "Very high for common views", "High", "Medium–high", "Medium", "After daily store"],
  ["Reduced debug payload", "Low–medium", "None", "Low", "Low", "Quick win"],
], [1800, 1450, 1750, 1250, 1350, 1760]));

children.push(h1("12. Recommended roadmap"));
children.push(h2("Phase 1 — Stabilize current live-query design"));
children.push(bullet("Create a global per-shop ShopifyQL scheduler with adaptive cooldown."));
children.push(bullet("Convert cache keys to reusable canonical day/week chunks."));
children.push(bullet("Return compact debug metadata by default."));
children.push(bullet("Add query-stage timings: cache, Shopify wait, merge, serialization and browser render."));
children.push(p("Expected result: fewer incomplete reports and clearer RCA with limited infrastructure change."));

children.push(h2("Phase 2 — Move Product Audit computation to the server"));
children.push(bullet("Send selected dimensions, filters, sort and page to the loader."));
children.push(bullet("Aggregate, filter, sort and paginate on the server."));
children.push(bullet("Return only summary totals and the selected page."));
children.push(bullet("Run all-results exports on the server."));
children.push(p("Expected result: major reduction in browser hangs and response size."));

children.push(h2("Phase 3 — Production analytics foundation"));
children.push(bullet("Migrate production cache/session storage from SQLite to managed PostgreSQL."));
children.push(bullet("Store normalized shop-product-day facts with unique keys to prevent duplicates."));
children.push(bullet("Backfill historical data gradually with rate-aware workers."));
children.push(bullet("Refresh yesterday and recent mutable dates on schedule."));
children.push(bullet("Build Product Audit and New Arrival reports from the shared local fact table."));
children.push(p("Expected result: scalable multi-store reporting, predictable page load time and minimal dependence on live ShopifyQL during page opening."));

children.push(h2("Recommended decision"));
children.push(callout("Balanced path", "Implement server-side aggregation/pagination and a global request scheduler first. Then introduce canonical cache chunks. Move to a managed daily analytics store when live stores or report volume justify the recurring database and worker cost.", "E3F1DF"));

children.push(pageBreak(), h1("13. Acceptance criteria"));
children.push(h2("Report correctness"));
children.push(bullet("Every money value uses the store's default currency."));
children.push(bullet("Product totals and unique-order totals use their documented grouping rules."));
children.push(bullet("No truncated or failed dataset is silently presented as complete."));
children.push(bullet("New Arrival first-cohort lookback and Product Tag duplication rules remain unchanged during optimization."));
children.push(h2("Performance targets for the next architecture"));
children.push(bullet("Cached report first response target: under 2 seconds."));
children.push(bullet("Uncached standard report target: visible progress immediately and completion without browser unresponsiveness."));
children.push(bullet("Browser receives only the rows necessary for the current view."));
children.push(bullet("Heavy export/report work survives normal web-request timeout boundaries through background jobs."));
children.push(h2("Reliability and operations"));
children.push(bullet("Per-shop queue prevents uncontrolled concurrent ShopifyQL bursts."));
children.push(bullet("Retries use bounded exponential/adaptive backoff and never loop forever."));
children.push(bullet("Successful chunks are retained when another chunk fails."));
children.push(bullet("Monitoring separates cache time, Shopify time, server calculation time and browser rendering time."));

children.push(h1("14. Plain-language glossary"));
children.push(table(["Term", "Meaning"], [
  ["Aggregation", "Combining many detailed rows into totals, such as daily rows into monthly product totals."],
  ["Server-side", "Work done on the app server before data is sent to the merchant's browser."],
  ["Cache", "A saved successful result that can be reused instead of requesting Shopify again."],
  ["Chunk", "A smaller date segment of a large request."],
  ["Rate limit / throttle", "Shopify temporarily refuses requests because too many were made in a short time."],
  ["Timeout", "A request took longer than the permitted waiting period."],
  ["Pagination", "Returning one manageable page of rows rather than every row at once."],
  ["Background job", "Long work performed separately from the page request, with progress and a stored result."],
  ["Normalized daily data", "One consistent database record per shop, product and date that can be reused by multiple reports."],
  ["Directional CR", "Orders divided by landing sessions; useful for comparison, but not exact product conversion because it excludes sessions that started elsewhere."],
], [2450, 6910]));

children.push(new Paragraph({ spacing: { before: 400 }, border: { top: { style: BorderStyle.SINGLE, size: 8, color: GREEN } }, children: [] }));
children.push(p("End of document", { alignment: AlignmentType.CENTER, color: MUTED, size: 18 }));

const doc = new Document({
  creator: "Audit Bot Product Team",
  title: "Audit Bot Current-State PRD",
  description: "Current architecture, workflows, data fetching and performance optimization decision guide.",
  numbering: { config: [{ reference: "bullets", levels: [{ level: 0, format: "bullet", text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 420, hanging: 220 } } } }, { level: 1, format: "bullet", text: "◦", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 760, hanging: 220 } } } }] }] },
  styles: {
    default: { document: { run: { font: "Arial", size: 21, color: TEXT }, paragraph: { spacing: { line: 290 } } } },
    paragraphStyles: [
      { id: "Title", name: "Title", basedOn: "Normal", next: "Normal", run: { font: "Arial", size: 42, bold: true, color: NAVY } },
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: "Arial", size: 30, bold: true, color: NAVY }, paragraph: { outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: "Arial", size: 25, bold: true, color: GREEN }, paragraph: { outlineLevel: 1 } },
      { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: "Arial", size: 22, bold: true, color: TEXT }, paragraph: { outlineLevel: 2 } },
    ],
  },
  sections: [{
    properties: { page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } } },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: "Audit Bot PRD  |  ", color: MUTED, size: 17 }), new TextRun({ children: [PageNumber.CURRENT], color: MUTED, size: 17 })] })] }) },
    children,
  }],
});

Packer.toBuffer(doc).then((buffer) => {
  fs.writeFileSync(OUT, buffer);
  console.log(OUT);
});
