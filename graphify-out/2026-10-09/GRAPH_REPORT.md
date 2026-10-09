# Graph Report - audit-bot  (2026-10-09)

## Corpus Check
- 113 files · ~84,330 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 16 file(s) not represented in the graph (top: (none) 7, .css 4, .toml 2)

## Summary
- 998 nodes · 1721 edges · 68 communities (51 shown, 17 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 12 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `66c17ca7`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- app.new-arrivals.jsx
- supabase-session-storage.server.js
- app.products.jsx
- package.json
- SecondLook — Product Audit Data Flow
- decision.md
- flow.md
- @shopify/shopify-app-template-remix
- Gotchas / Troubleshooting
- generate-current-state-prd.cjs
- compilerOptions
- devDependencies
- 2026-08-12 — Product catalog ke liye Bulk Operation + cache
- scripts
- dependencies
- SecondLook — Decision Log
- compare-product-audit-sources.mjs
- analytics-bootstrap.client.js
- 2026-08-12 — Stale Prisma client ko automatically replace karna
- 2026-08-12 — Historical analytics cache
- 2026-08-17 — Shopify-style two-column report layout
- convert-prd-to-pdf.cjs
- 2026-08-12 — Product Page Views aur Landing Sessions ko separate metrics banana
- 2026-08-13 — Per-product complete sales breakup add karna
- 2026-08-12 — Duplicate sessions query remove karna
- 2026-08-12 — Independent requests parallel me chalana + retry
- 2026-08-12 — Per-product Product Sessions add karna
- 2026-08-13 — Multi-format Export menu with page/all scope
- shopify-dev-mcp
- 2026-08-12 — Catalog refresh status me exact time dikhana
- 2026-08-12 — Progressive loading and safer export
- 2026-08-12 — ShopifyQL row limit fix
- shopify-dev-mcp
- analytics-file-cache.server.js
- 2026-08-12 — Currency and inventory-date semantics
- 2026-08-17 — Metric totals inventory removal and unique Orders
- shopify-supabase-sync.server.js
- createAuthenticatedStoreAnalytics
- 2026-08-31 — Polaris light data-visibility refactor
- New Arrival report interaction flow (2026-08-31)
- product-lifecycle.server.js
- monthly-product-metadata.test.js
- atomic-product-tags.test.js
- store-inventory-summary-naming.test.js
- monthly-currency-history.test.js
- .graphqlrc.js
- shopify.server.js
- @react-router/fs-routes
- engines
- overrides
- apply-supabase-migration.mjs
- verify-product-audit-source.mjs
- new-arrival-engine.server.js
- new-arrival-monthly-source.server.js
- DateRangePicker.jsx
- analytics-performance.server.js
- react-router
- normalizeNewArrivalRange
- app.jsx
- app._index.jsx
- auth.login/route.jsx
- entry.server.jsx
- auth.$.jsx
- vite

## God Nodes (most connected - your core abstractions)
1. `createAuthenticatedStoreAnalytics()` - 38 edges
2. `SecondLook — Decision Log` - 28 edges
3. `SecondLook — Product Audit Data Flow` - 27 edges
4. `shopifyIdText()` - 26 edges
5. `syncLatest18MonthsToFileCache()` - 21 edges
6. `syncLatest18MonthsToSupabase()` - 21 edges
7. `request()` - 21 edges
8. `@shopify/shopify-app-template-remix` - 19 edges
9. `2026-08-31 — Polaris light data-visibility refactor` - 19 edges
10. `New Arrival report interaction flow (2026-08-31)` - 19 edges

## Surprising Connections (you probably didn't know these)
- `reportWithInventoryAuditDate()` --calls--> `generateNewArrivalReport()`  [EXTRACTED]
  tests/new-arrival-cohort-rules.test.js → app/new-arrival-engine.server.js
- `reconcileSupabaseProductCatalog()` --indirect_call--> `shopifyIdText()`  [INFERRED]
  app/supabase-analytics.server.js → app/shopify-id.js
- `fetchInventoryChunk()` --calls--> `runWithAnalyticsCache()`  [EXTRACTED]
  app/routes/app.products.jsx → app/analytics-cache.server.js
- `loader()` --calls--> `runWithAnalyticsCache()`  [EXTRACTED]
  app/routes/app.products.jsx → app/analytics-cache.server.js
- `dueAnalyticsStores()` --calls--> `readAnalyticsManifest()`  [EXTRACTED]
  app/analytics-daily-refresh.server.js → app/analytics-file-cache.server.js

## Import Cycles
- None detected.

## Communities (68 total, 17 thin omitted)

### Community 0 - "app.new-arrivals.jsx"
Cohesion: 0.07
Nodes (53): isFinalizedRange(), runWithAnalyticsCache(), addAnalysisSection(), analysisSections(), applyExcelNumberFormat(), categoryLoadQueue, csvCell(), dateString() (+45 more)

### Community 1 - "supabase-session-storage.server.js"
Cohesion: 0.26
Nodes (7): configuration(), isoDate(), request(), rowSession(), sessionRow(), SupabaseSessionStorage, @shopify/shopify-api

### Community 2 - "app.products.jsx"
Cohesion: 0.06
Nodes (53): addSales(), createReport(), currencyScale(), emptySales(), hasExactCoverage(), loadDatabaseMonths(), loadFileCacheMonths(), loadProductAuditMonthlyReport() (+45 more)

### Community 3 - "package.json"
Cohesion: 0.07
Nodes (28): author, name, private, trustedDependencies, type, workspaces, eslint, eslint-import-resolver-typescript (+20 more)

### Community 4 - "SecondLook — Product Audit Data Flow"
Cohesion: 0.05
Nodes (40): Automatic ShopifyQL range recovery, Bulk failure fallback, Case A: fresh cache, Case B: stale cache, Case C: no cache, Configurable report builder flow, Current/recent period, Debug panel meaning (+32 more)

### Community 5 - "decision.md"
Cohesion: 0.04
Nodes (49): 2026-08-20 — New Arrival Analysis port, 2026-08-31 — Conversion-focused landing page and command center, 2026-09-11 - Align Product Audit date UX and navigation loading, 2026-09-11 - Calculation dictionary clarity, 2026-09-11 - Calculation drawer section navigation, 2026-09-11 - Chunk Product Audit inventory snapshots, 2026-09-11 - Compact dual-calendar navigation, 2026-09-11 - Prevent Product Audit dimension regrouping freezes (+41 more)

### Community 6 - "flow.md"
Cohesion: 0.04
Nodes (46): 2026-09-11 - Calculation drawer accordion, 2026-09-11 - Calculation drawer reference flow, 2026-09-11 - Cohort Details filters, 2026-09-11 - Date picker interaction, 2026-09-11 - Monthly quick ranges, 2026-09-11 - Product Audit date-change feedback, 2026-09-11 - Product Audit dimension-change flow, 2026-09-11 - Product Audit inventory chunk flow (+38 more)

### Community 7 - "@shopify/shopify-app-template-remix"
Cohesion: 0.06
Nodes (31): 2024.08.19, 2024.09.17, 2024.09.18, 2024.10.02, 2024.10.29, 2024.11.06, 2024.11.26, 2024.12.04 (+23 more)

### Community 8 - "Gotchas / Troubleshooting"
Cohesion: 0.08
Nodes (24): Application Storage, Authenticating and querying data, Build, Database tables don't exist, Deployment, Gotchas / Troubleshooting, Hosting, Incorrect GraphQL Hints (+16 more)

### Community 9 - "generate-current-state-prd.cjs"
Cohesion: 0.11
Nodes (12): {
  AlignmentType, BorderStyle, Document, Footer, HeadingLevel, PageBreak,
  PageNumber, Packer, Paragraph, ShadingType, Table, TableCell, TableRow,
  TextRun, WidthType,
}, badge(), border, borders, cell(), children, doc, flow() (+4 more)

### Community 10 - "compilerOptions"
Cohesion: 0.10
Nodes (19): compilerOptions, allowJs, allowSyntheticDefaultImports, baseUrl, forceConsistentCasingInFileNames, isolatedModules, jsx, lib (+11 more)

### Community 11 - "devDependencies"
Cohesion: 0.10
Nodes (20): devDependencies, eslint, eslint-import-resolver-typescript, eslint-plugin-import, eslint-plugin-jsx-a11y, eslint-plugin-react, eslint-plugin-react-hooks, graphql-config (+12 more)

### Community 12 - "2026-08-12 — Product catalog ke liye Bulk Operation + cache"
Cohesion: 0.20
Nodes (10): 2026-08-12 — Product catalog ke liye Bulk Operation + cache, Consequences / risks, Decision, Error aaye toh kya check karein, Expected benefit, Implementation, Problem / context, Rollback (+2 more)

### Community 13 - "scripts"
Cohesion: 0.11
Nodes (18): scripts, build, config:link, config:use, deploy, dev, docker-start, env (+10 more)

### Community 14 - "dependencies"
Cohesion: 0.12
Nodes (17): dependencies, exceljs, isbot, prisma, @prisma/client, react, react-dom, react-router (+9 more)

### Community 15 - "SecondLook — Decision Log"
Cohesion: 0.12
Nodes (17): 2026-08-12 — Browser/table performance, 2026-08-13 cart-addition removal and reporting timing finding, 2026-08-13 — Configurable Product Audit report builder, 2026-08-13 — Product quantity sales metrics, 2026-08-13 — Purchases replaced by product Orders, 2026-08-13 — Sticky Product Audit table header and first column, 2026-08-13 — Top report toolbar placement, 2026-08-17 — ShopifyQL automatic date-range splitting correction (+9 more)

### Community 16 - "compare-product-audit-sources.mjs"
Cohesion: 0.11
Nodes (20): allDifferences, baseUrl, compareMetricMaps(), completeMonths, emptyMetric(), handleFromPath(), headers, mergeSourceRows() (+12 more)

### Community 17 - "analytics-bootstrap.client.js"
Cohesion: 0.22
Nodes (18): bootstrapAnalyticsData(), progressStatus(), responseJson(), runOneStep(), syncStatus(), wait(), waitForInteractiveReportIdle(), waitForRunningSync() (+10 more)

### Community 18 - "2026-08-12 — Stale Prisma client ko automatically replace karna"
Cohesion: 0.20
Nodes (10): 2026-08-12 — Stale Prisma client ko automatically replace karna, Consequences / risks, Decision, Error aaye toh kya check karein, Expected benefit, Implementation, Problem / context, Rollback (+2 more)

### Community 19 - "2026-08-12 — Historical analytics cache"
Cohesion: 0.29
Nodes (7): 2026-08-12 — Historical analytics cache, Consequences / risks, Decision, Error aaye toh kya check karein, Expected benefit, Rules, Simple explanation

### Community 20 - "2026-08-17 — Shopify-style two-column report layout"
Cohesion: 0.29
Nodes (7): 2026-08-17 — Shopify-style two-column report layout, Collapsible whole-sidebar scrolling correction, Full available-height correction, Full-width and zoom-responsive correction, Independent Metrics and Dimensions scrolling, Product search section removed, Shopify-style controls-panel viewport

### Community 21 - "convert-prd-to-pdf.cjs"
Cohesion: 0.29
Nodes (6): fs, input, mammoth, outputDir, path, tempDir

### Community 22 - "2026-08-12 — Product Page Views aur Landing Sessions ko separate metrics banana"
Cohesion: 0.33
Nodes (6): 2026-08-12 — Product Page Views aur Landing Sessions ko separate metrics banana, Consequences / risks, Data sources, Decision, Important terminology, Verification required on store

### Community 23 - "2026-08-13 — Per-product complete sales breakup add karna"
Cohesion: 0.33
Nodes (6): 2026-08-13 — Per-product complete sales breakup add karna, Attribution limitation, Cache decision, Consequences, Data source, Decision

### Community 24 - "2026-08-12 — Duplicate sessions query remove karna"
Cohesion: 0.40
Nodes (5): 2026-08-12 — Duplicate sessions query remove karna, Additional correction, Consequence, Decision, Problem

### Community 25 - "2026-08-12 — Independent requests parallel me chalana + retry"
Cohesion: 0.40
Nodes (5): 2026-08-12 — Independent requests parallel me chalana + retry, Consequences / risks, Decision, Expected benefit, Simple explanation

### Community 26 - "2026-08-12 — Per-product Product Sessions add karna"
Cohesion: 0.40
Nodes (5): 2026-08-12 — Per-product Product Sessions add karna, Consequences / risks, Decision, Definition, Logic

### Community 27 - "2026-08-13 — Multi-format Export menu with page/all scope"
Cohesion: 0.40
Nodes (5): 2026-08-13 — Multi-format Export menu with page/all scope, 2026-08-13 visibility correction, Consequences, Decision, Format behavior

### Community 28 - "shopify-dev-mcp"
Cohesion: 0.50
Nodes (3): npx, @shopify/dev-mcp, shopify-dev-mcp

### Community 29 - "2026-08-12 — Catalog refresh status me exact time dikhana"
Cohesion: 0.50
Nodes (4): 2026-08-12 — Catalog refresh status me exact time dikhana, Consequence, Decision, Reason

### Community 30 - "2026-08-12 — Progressive loading and safer export"
Cohesion: 0.50
Nodes (4): 2026-08-12 — Progressive loading and safer export, Consequences, Decision, Rules

### Community 31 - "2026-08-12 — ShopifyQL row limit fix"
Cohesion: 0.50
Nodes (4): 2026-08-12 — ShopifyQL row limit fix, Decision, Reason, Safety

### Community 32 - "shopify-dev-mcp"
Cohesion: 0.50
Nodes (3): npx, @shopify/dev-mcp, shopify-dev-mcp

### Community 33 - "analytics-file-cache.server.js"
Cohesion: 0.15
Nodes (30): analyticsFilePaths(), analyticsFileSchemaVersion, compressJson(), gunzipAsync, gzipAsync, jsonBuffer(), monthValue(), parseCompressedJson() (+22 more)

### Community 34 - "2026-08-12 — Currency and inventory-date semantics"
Cohesion: 0.67
Nodes (3): 2026-08-12 — Currency and inventory-date semantics, Decisions, Important distinction

### Community 35 - "2026-08-17 — Metric totals inventory removal and unique Orders"
Cohesion: 0.67
Nodes (3): 2026-08-17 — Metric totals inventory removal and unique Orders, Expanded filter operators, Result table Summary row

### Community 38 - "shopify-supabase-sync.server.js"
Cohesion: 0.07
Nodes (66): dailyRefreshDue(), dueAnalyticsStores(), localHour(), finiteNumber(), nonNegativeInventory(), sumNonNegativeInventory(), handleFromLandingPath(), matchLandingSessions() (+58 more)

### Community 39 - "createAuthenticatedStoreAnalytics"
Cohesion: 0.12
Nodes (36): analyticsDatabaseCapacityPolicy(), analyticsStorageSizing, positiveInteger(), projectedStoreStorageBytes(), refreshProductCatalog(), action(), loader(), ensureShopifyStoreStorageAssignment() (+28 more)

### Community 40 - "2026-08-31 — Polaris light data-visibility refactor"
Cohesion: 0.11
Nodes (19): 2026-08-31 — In-context cohort methodology, 2026-08-31 — New Arrival classification and time dimensions, 2026-08-31 — New Arrival sales basis, 2026-08-31 — Polaris light data-visibility refactor, 2026-09-01 — Custom New Arrival matrix columns, 2026-09-01 — Explicit report processing states, 2026-09-01 — Final category loading policy: click only, 2026-09-01 — Product Tag classification performance fix (+11 more)

### Community 41 - "New Arrival report interaction flow (2026-08-31)"
Cohesion: 0.11
Nodes (19): 2026-08-31 — Metric explanation flow, 2026-08-31 — New Arrival dimension flow, 2026-08-31 — New Arrival sales calculation, 2026-09-01 — Custom matrix-column flow, 2026-09-01 — Final click-only category flow, 2026-09-01 — Loading-state flow, 2026-09-01 — Product Tag matrix rendering flow, 2026-09-01 — Staged tag preparation flow (+11 more)

### Community 42 - "product-lifecycle.server.js"
Cohesion: 0.60
Nodes (3): CATALOG_STATES, effectiveProductStatus(), isValidCatalogState()

### Community 48 - "shopify.server.js"
Cohesion: 0.13
Nodes (10): apiVersion, authenticate, localSessionStorage, registerWebhooks, sessionStorage, shopify, @prisma/client, @shopify/shopify-app-session-storage-prisma (+2 more)

### Community 52 - "apply-supabase-migration.mjs"
Cohesion: 0.33
Nodes (3): pg, applyWithDirectConnection(), dryRun

### Community 54 - "new-arrival-engine.server.js"
Cohesion: 0.30
Nodes (11): aggregateProductMonths(), brandDenominators(), buildProductMaps(), buildRecords(), calculateMatrix(), calculateUnattributedMatrix(), generateNewArrivalReport(), includeUnattributedSales() (+3 more)

### Community 55 - "new-arrival-monthly-source.server.js"
Cohesion: 0.30
Nodes (14): activeInLookback(), currencyScale(), dateString(), hasExactCoverage(), loadNewArrivalMonthlySource(), loadUncachedNewArrivalMonthlySource(), monthEnd(), newArrivalLookbackBounds() (+6 more)

### Community 56 - "DateRangePicker.jsx"
Cohesion: 0.38
Nodes (11): asDate(), calendarDays(), CalendarPanel(), clampMonth(), DateRangePicker(), firstOfMonth(), isoDate(), MONTHS (+3 more)

### Community 59 - "analytics-performance.server.js"
Cohesion: 0.20
Nodes (14): ALLOWED_CACHE_STATUSES, ALLOWED_INTERVALS, ALLOWED_PHASES, ALLOWED_REQUEST_KINDS, ALLOWED_SOURCES, ALLOWED_STATUSES, allowedText(), analyticsResponseBytes() (+6 more)

### Community 61 - "normalizeNewArrivalRange"
Cohesion: 0.67
Nodes (5): dateString(), monthString(), normalizeNewArrivalRange(), shiftMonth(), startOfWeek()

### Community 62 - "app.jsx"
Cohesion: 0.29
Nodes (3): App(), headers(), react

### Community 64 - "auth.login/route.jsx"
Cohesion: 0.52
Nodes (4): loginErrorMessage(), action(), loader(), login

### Community 65 - "entry.server.jsx"
Cohesion: 0.40
Nodes (5): handleRequest(), streamTimeout, addDocumentResponseHeaders, isbot, @react-router/node

## Knowledge Gaps
- **466 isolated node(s):** `npx`, `@shopify/dev-mcp`, `config`, `npx`, `@shopify/dev-mcp` (+461 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 539 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **17 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `react-router` connect `react-router` to `app.new-arrivals.jsx`, `entry.server.jsx`, `app.products.jsx`, `auth.login/route.jsx`, `package.json`, `app.jsx`, `app._index.jsx`?**
  _High betweenness centrality (0.044) - this node is a cross-community bridge._
- **Why does `react` connect `app.jsx` to `app.new-arrivals.jsx`, `auth.login/route.jsx`, `app.products.jsx`, `package.json`, `DateRangePicker.jsx`?**
  _High betweenness centrality (0.038) - this node is a cross-community bridge._
- **Why does `shopifyIdText()` connect `shopify-supabase-sync.server.js` to `app.new-arrivals.jsx`, `app.products.jsx`, `new-arrival-engine.server.js`, `createAuthenticatedStoreAnalytics`?**
  _High betweenness centrality (0.027) - this node is a cross-community bridge._
- **What connects `npx`, `@shopify/dev-mcp`, `config` to the rest of the system?**
  _466 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `app.new-arrivals.jsx` be split into smaller, more focused modules?**
  _Cohesion score 0.06963645673323093 - nodes in this community are weakly interconnected._
- **Should `app.products.jsx` be split into smaller, more focused modules?**
  _Cohesion score 0.0625 - nodes in this community are weakly interconnected._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.06896551724137931 - nodes in this community are weakly interconnected._