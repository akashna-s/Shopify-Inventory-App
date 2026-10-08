# SecondLook — Decision Log

> Is file ka purpose: project me har important technical decision ko simple Hinglish me record karna, taaki baad me pata rahe **kya badla, kyun badla, kya risk hai, aur problem aaye toh kya check/rollback karna hai**.

## Is file ko maintain karne ka rule

Har major change ke liye ek nayi dated entry add hogi. Purani entry delete nahi hogi. Entry me ye sections honge:

- Decision
- Problem / context
- Simple explanation
- Implementation
- Expected benefit
- Consequences / risks
- Error aaye toh kya check karein
- Rollback
- Verification

---

## 2026-08-12 — Stale Prisma client ko automatically replace karna

### Decision

Development mode me agar memory me pada Prisma client naye cache models ko nahi jaanta, toh app us purane client ko disconnect karke naya client banayega.

### Problem / context

Product page par error aaya:

```text
Cannot read properties of undefined (reading 'findUnique')
```

Analytics queries chal rahi thi, lekin products nahi aa rahe the.

### Simple explanation

Database ko ek office samjho aur Prisma ko office ka receptionist.

- Humne office me do naye cupboards banaye: `ProductCatalogCache` aur `AnalyticsCache`.
- Lekin receptionist purani directory pakad ke baitha tha.
- Isliye jab code ne kaha “ProductCatalogCache cupboard kholo”, receptionist ko cupboard ka naam hi nahi mila.
- Result: `.findUnique()` chalane ke liye object nahi tha aur page fail ho gaya.

### Implementation

File: `app/db.server.js`

Development me app check karta hai:

1. Kya global Prisma client already memory me hai?
2. Kya usme `productCatalogCache` aur `analyticsCache` available hain?
3. Agar nahi, purane client ko disconnect karo.
4. Naya Prisma client create karo.

### Expected benefit

- Cache model add/change karne ke baad stale development client ki wajah se page blank nahi hoga.
- Product cache aur analytics cache dono same issue se protected hain.

### Consequences / risks

- Ye check mainly development hot reload ke liye hai.
- Production deployment me `prisma generate` aur migration deployment process ka part rehna chahiye.
- Schema badalne ke baad dev server restart karna phir bhi safest practice hai.

### Error aaye toh kya check karein

1. `npx prisma migrate status`
2. `npx prisma generate`
3. Dev server restart
4. `ProductCatalogCache` table migration applied hai ya nahi
5. Debug panel me `Product catalog: unavailable` aa raha hai ya cache source

### Rollback

`app/db.server.js` se stale-client detection hata kar old global Prisma initialization restore ki ja sakti hai. Recommended nahi hai, kyunki model changes ke baad same error dobara aa sakta hai.

### Verification

- Exact stale-client condition simulate ki gayi.
- Naye client me dono APIs available mili:
  - `productCatalogCache: true`
  - `analyticsCache: true`
- ESLint passed.
- Production client and server build passed.

---

## 2026-08-12 — Product catalog ke liye Bulk Operation + cache

### Decision

Har page load par thousands of products ko 250-250 karke fetch karne ke badle Shopify Bulk Operation se catalog banana aur database me save karna.

### Problem / context

Large catalog me normal pagination ko bahut network rounds lagte hain. Date filter badalne par bhi product master data dobara fetch ho raha tha, jabki title, tags, handle aur created date selected timeline par depend nahi karte.

### Simple explanation

Purana system har baar godown se 250 products ki trolley mangata tha. 10,000 products ke liye lagbhag 40 trolley trips.

Naya system Shopify ko bolta hai: “poori product list ki ek file bana do.” File ready hone ke baad app usko save kar leta hai. Agli baar godown jaane ki zarurat nahi—saved list use hoti hai.

### Implementation

Files:

- `app/product-catalog-cache.server.js`
- `prisma/schema.prisma`
- `prisma/migrations/20260812090000_add_audit_caches/migration.sql`

Rules:

- Cache age under 6 hours: directly use it.
- Cache older than 6 hours: old data immediately show karo, refresh background me.
- Cache missing: first bulk export ka wait karo.
- Bulk export fail: old 250-product pagination fallback use karo.
- Cache key shop domain hai, so stores ka data mix nahi hoga.

### Expected benefit

- First successful cache ke baad product list much faster.
- Day/Week/Month change par catalog repeat fetch nahi.
- Shopify Admin API requests significantly fewer.

### Consequences / risks

- First-ever load slow ho sakta hai.
- Product change maximum 6 hours late reflect ho sakta hai.
- SQLite me catalog JSON storage consume karega.
- Background refresh ke liye Node server running rehna chahiye.

### Error aaye toh kya check karein

- Debug panel: `Product catalog: cache`, `bulk`, `stale-cache-refreshing`, ya `unavailable`.
- Server logs: `[Product catalog] bulk export failed...`
- Prisma cache model/client availability.
- Shopify bulk operation status and permissions.

### Rollback

Route me `getProductCatalog()` ke badle old pagination function use kiya ja sakta hai. Cache tables ko immediately delete karna required nahi; unused tables harmless rahengi.

### Verification

- Database migration applied.
- Cache tables runtime se accessible.
- Bulk failure fallback code present.
- Production build passed.

---

## 2026-08-12 — Historical analytics cache

### Decision

Completed historical periods ke sessions, sales aur inventory results save karna. Recent/current range live Shopify se fetch hoga.

### Simple explanation

Last year August ka report har baar Shopify se mangane ka fayda nahi. Ek baar verified result save karne ke baad same copy use kar sakte hain. Lekin aaj/current month ke numbers badalte rehte hain, isliye unko live fetch karna hai.

### Rules

- Range end hone ke 3 din baad hi final maana jayega.
- Current ya recent range cache nahi hogi.
- Cache identity: store + dataset + start date + end date + cache version.
- Error ya truncated response save nahi hoga.

### Expected benefit

- Old reports near-instant.
- ShopifyQL calls and rate-limit pressure lower.

### Consequences / risks

- Shopify 3 din ke baad historical correction kare toh old saved result rahega.
- Cache version bump karke all old results invalidate kiye ja sakte hain.
- Date finalization currently server timezone use karti hai; future me store timezone add karna better hoga.

### Error aaye toh kya check karein

- Debug panel me `cache: hit` ya `cache: miss`.
- `AnalyticsCache` table and generated Prisma client.
- Selected range current/recent hai toh cache status absent hona expected hai.

---

## 2026-08-12 — Independent requests parallel me chalana + retry

### Decision

Catalog, shop info, sessions, sales aur inventory ko one-by-one ke badle ek saath start karna. Temporary Shopify errors par maximum 3 total attempts.

### Simple explanation

Pehle paanch workers ek line me khade the: worker 2 tab start karta tha jab worker 1 complete hota. Ab sab apna independent kaam same time start karte hain.

Temporary error par waits:

- Retry 1: 750 ms
- Retry 2: 1.5 seconds

Wrong query jaisa permanent error retry nahi hota.

### Expected benefit

Total wait roughly slowest request ke aas-paas, sab request times ka total nahi.

### Consequences / risks

- Same time calls Shopify rate allowance ko quickly use kar sakti hain.
- Bounded retry temporary throttling handle karta hai.
- Debug panel attempts aur elapsed time show karta hai.

---

## 2026-08-12 — Duplicate sessions query remove karna

### Decision

Ek hi product-session ShopifyQL result se totals aur landing-page breakdown banana.

### Problem

Second sessions query all landing page types fetch karke non-product rows discard kar rahi thi.

### Additional correction

Same product ke multiple landing paths pehle overwrite hote the. Ab sessions, add-to-cart aur purchases add hote hain.

### Consequence

Multi-path products ke numbers old report se higher ho sakte hain. Ye data correction hai, duplicate counting tabhi hogi agar ShopifyQL itself same session ko multiple grouped paths me report kare—debug breakdown se verify kiya ja sakta hai.

---

## 2026-08-12 — Progressive loading and safer export

### Decision

Blank page ke badle loading screen show karna. Filter change par existing report visible rakhna aur new report background me resolve karna.

### Rules

- Report incomplete ho toh Excel export disabled.
- Loading error ke liye dedicated message.
- Cold bulk load allow karne ke liye stream timeout 120 seconds.

### Consequences

- First cold request maximum 2 minutes open reh sakti hai.
- Cached requests normally much faster resolve hongi.

---

## 2026-08-12 — Browser/table performance

### Decisions

- 250 ke badle 50 visible rows per page.
- Search input deferred, so typing responsive rahe.
- Row hover JavaScript ke badle CSS.
- Excel library only Export click par load.
- `onlineStoreUrl` API field remove; store domain + handle se URL build.

### Consequences

- More pagination clicks.
- First export click par short download delay.
- Standard `/products/{handle}` storefront route assume hota hai.

---

## 2026-08-12 — ShopifyQL row limit fix

### Decision

Queries me explicit `LIMIT 100000` add karna.

### Reason

Without explicit limit ShopifyQL result 1,000 rows par silently cut ho raha tha. Low-value products ke sales/sessions missing dikh rahe the.

### Safety

Returned rows requested limit ko hit karein toh warning show hoti hai.

---

## 2026-08-12 — Currency and inventory-date semantics

### Decisions

- Money store default currency me format hota hai.
- Starting/ending inventory selected timeline ke according.
- `first_day_in_inventory` Shopify ka selected-range-relative metric rahega.
- `createdAt` fixed Admin API product creation timestamp hai.
- Misleading duplicate `launchDate` remove kiya gaya.

### Important distinction

- `createdAt`: product Shopify me kab create hua; filter-independent.
- `first_day_in_inventory`: selected range ke andar inventory dataset ka first relevant day; filter-dependent.

---

## 2026-08-12 — Catalog refresh status me exact time dikhana

### Decision

Product catalog debug status me refresh date ke saath local time bhi show hoga.

Example:

```text
Product catalog: cache · refreshed Aug 12, 2026, 4:18 PM
```

### Reason

Sirf date se ye clear nahi tha ki six-hour catalog cache kitni purani hai. Exact time se merchant easily samajh sakta hai ki product changes abhi cache me expected hain ya refresh due hai.

### Consequence

Time browser/server se serialized timestamp ko viewer ke local timezone me format karta hai. Different timezone me page kholne wale users ko unka local time dikh sakta hai.

---

## 2026-08-12 — Product Page Views aur Landing Sessions ko separate metrics banana

### Decision

Purane `Sessions` + URL breakdown ko replace karke do genuinely different product metrics show karna:

1. `Product Page Views`: selected period me product page kitni baar load/view hui.
2. `Landing Sessions`: kitni online-store sessions us product page se start hui.

Individual landing URLs, percentages aur expandable breakdown remove kar diya gaya.

### Important terminology

User requirement me first metric ko “total sessions” kaha gaya tha, lekin “page kitni baar view hua” technically session nahi hota. Ek session me same page multiple baar view ho sakti hai. Isliye accurate display name `Product Page Views` rakha gaya.

### Data sources

- Product Page Views: `FROM web_performance SHOW page_loads WHERE page_type = 'Product' GROUP BY page_path`
- Landing Sessions/funnel: `FROM sessions ... WHERE landing_page_type = 'product' GROUP BY landing_page_path`

Dono results me `/products/{handle}` extract karke all URL extensions/variants same product total me add hote hain.

### Consequences / risks

- Page views normally landing sessions se equal ya higher honge.
- `web_performance` page-load dataset sessions dataset se alag processing/reporting source hai; short reporting lag possible hai.
- Conversion rate purchases divided by landing sessions rahega, page views se divide nahi hoga.
- Historical cache keys naye dataset names use karte hain, so old sessions cache wrong metric me reuse nahi hogi.

### Verification required on store

- Debug panel me `productPageViews` aur `landingSessionTotals` dono successful hone chahiye.
- Known product ke liye Product Page Views generally Landing Sessions se kam nahi hone chahiye; exceptions analytics processing/data coverage issue indicate kar sakte hain.
- Excel me URL bifurcation columns absent aur new two numeric columns present hone chahiye.

---

## 2026-08-12 — Per-product Product Sessions add karna

### Decision

`Product Page Views` aur `Landing Sessions` ke beech third metric `Product Sessions` add karna.

### Definition

- Product Page Views: product page total load events.
- Product Sessions: unique online-store sessions jisme product page at least once load hui.
- Landing Sessions: unique sessions jo isi product page se start hui.

Example:

```text
Session ABC me same product 3 baar load
Product Page Views = 3
Product Sessions = 1
Landing Sessions = 0 ya 1, depending on journey ki first page
```

### Logic

`web_performance` query `page_path` aur `micro_session_id` se grouped hai. Per product:

- `page_loads` ka sum = Product Page Views.
- Unique `micro_session_id` Set size = Product Sessions.

Opaque session ID sirf current server request ki memory me deduplicate hoti hai. Ye granular query database analytics cache me save nahi hoti. Final browser table aur Excel me individual IDs expose nahi hote—sirf numeric count return hota hai.

### Consequences / risks

- Query rows increase hongi because each product-path/session combination separate row hai.
- Product Page Views/Sessions query every selection par live chalegi because raw session IDs ko database me persist nahi karna hai.
- 100,000 row limit hit hone par Product Page Views aur Product Sessions incomplete ho sakte hain; existing truncation warning show hogi.
- Same session me do products dekhe gaye toh each product ko one Product Session milega. Isliye top Product Sessions card per-product counts ka sum hai, unique storewide sessions nahi.
- Expected ordering generally: Product Page Views >= Product Sessions >= Landing Sessions.

---

## 2026-08-13 — Per-product complete sales breakup add karna

### Decision

Single `Total Sales` product metric ko Shopify ke eight sales components me expand karna:

- Gross Sales
- Discounts
- Sales Reversals (`gross_sales_reversals`)
- Net Sales
- Shipping Charges
- Return Fees
- Taxes
- Total Sales

Table, summary cards aur Excel export tino me same fields use honge.

### Data source

One ShopifyQL query:

```sql
FROM sales
SHOW gross_sales, discounts, gross_sales_reversals, net_sales,
     shipping_charges, return_fees, taxes, total_sales
GROUP BY product_id
```

Shopify ke returned signed amounts unchanged preserve honge. App discounts/reversals ko manually positive/negative convert nahi karegi.

### Cache decision

Historical cache dataset key `sales` se `sales-breakdown-v2` ki gayi. Reason: old cache me sirf `total_sales` tha; old cache reuse hoti toh new fields falsely zero dikhte.

### Attribution limitation

Shipping, tax, fee ya adjustment kabhi order-level event hota hai aur Shopify blank `product_id` row return kar sakta hai. App aise amount ko products par arbitrary divide nahi karti. UI informational note show karti hai, aur product rows sirf Shopify-attributed amounts dikhati hain.

### Consequences

- Wide table me horizontal scrolling increase hogi.
- Product-row sums Shopify store-wide total se differ kar sakte hain because unattributed/order-level amounts excluded hain.
- `Total Sales` formula me Shopify ke other applicable components—such as duties/additional fees—ho sakte hain, although separate columns current requested list me nahi hain.

---

## 2026-08-13 — Multi-format Export menu with page/all scope

### Decision

Product Audit ka old Excel-only button replace karke `Export` menu banana.

Scopes:

- Current page: currently displayed page ke maximum 50 products.
- All results: current timeframe aur search filter ke saare matching products.

Formats:

- CSV (`.csv`)
- XML (`.xml`)
- JSON Lines (`.jsonl`)

### Format behavior

- CSV UTF-8 BOM use karti hai, taaki Excel/non-English text ko correctly open kare. Commas, quotes aur line breaks escaped hain.
- XML special characters escape karti hai and one `<product>` node per result banati hai.
- JSON Lines one JSON product object per line rakhta hai, jo large files aur machine processing ke liye useful hai.

### Consequences

- Excel `.xlsx` Product Audit export remove ho gaya; CSV Excel me open ho sakti hai but workbook styling/sheets nahi hongi.
- All results client memory me already-loaded filtered rows se generate hota hai. Very large catalog export browser memory/download time use karega.
- Report refresh ke time export disabled rahega, so incomplete data download nahi hogi.

### 2026-08-13 visibility correction

Export dropdown ko `s-page` ke `primary-action` slot se hata kar Product Audit content ke top-right me rakha gaya. Shopify page header normal HTML wrapper ko reliable tarike se render nahi kar raha tha, isliye feature code me present hone ke bawajood button screen par hidden tha. Export scope aur file-generation logic unchanged hai.

---

## 2026-08-13 — Product quantity sales metrics

Product-level sales query me teen unit metrics add kiye:

- `Quantity ordered`: customer ne originally kitni units order ki, reversals minus hone se pehle.
- `Reversed quantity`: refund, cancellation, return ya order edit ke through kitni units reverse hui.
- `Net items sold`: reversals ke baad final sold units.

In metrics ko existing sales query me hi fetch kiya gaya, isliye separate Shopify request nahi badhi. Sales analytics cache key `sales-breakdown-v3` ki gayi, taaki old cache—jisme quantity fields nahi the—new report me zero values na dikhaye. Metrics table aur all export formats me included hain.

---

## 2026-08-13 — Sticky Product Audit table header and first column

Product table ko maximum `70vh` height ka internal scroll area banaya gaya. Har header cell vertical scroll ke waqt top par sticky hai, aur leftmost row-number (`#`) column horizontal scroll ke waqt left par sticky hai. Top-left header cell dono directions me fixed rehta hai. Frozen column par alternating row aur hover backgrounds preserve kiye gaye, taaki scrolling ke waqt neeche ka content uske through visible na ho.

---

## 2026-08-13 — Purchases replaced by product Orders

Old `Purchases` value `sessions_that_completed_checkout` se aa rahi thi. Woh purchased product ko count nahi karti thi; woh sirf batati thi ki kisi product landing page se start hui session ne checkout complete kiya. Isliye one order containing two products dono product rows par reliably `1` nahi dikha sakta tha.

Sales query me `orders` add karke table/export ka `Purchases` column `Orders` se replace kiya. Ek order me Bangle aur Saree hon toh dono product rows me `Orders = 1`; quantity ordered independently `2` aur `1` ho sakti hai. Sales cache key `sales-breakdown-v4` use hoti hai, taaki old cache missing orders ko zero na banaye.

Old `Add to Cart` ko `Landing Sessions with Cart Additions` rename kiya. Shopify sessions metric sirf batati hai ki product landing page se start hui session me koi item cart hua; ye guarantee nahi karti ki landing product hi add hua. Exact product ATC ko historical ShopifyQL sessions data se derive nahi kiya ja raha. Uske liye future storefront events capture karne wala Web Pixel/database flow separately required hoga.

Summary `Product Orders (summed)` per-product order counts add karta hai. Same order me two products hon toh summary me two product-order occurrences count hongi, although store-level unique order one hai. `Landing Session Conversion Rate` ab bhi completed landing sessions / landing sessions hai and product Orders se calculate nahi hota.

### 2026-08-13 cart-addition removal and reporting timing finding

`Landing Sessions with Cart Additions` ko ShopifyQL query, row mapping, summary, table aur exports se remove kiya, because user ko ye session-level metric required nahi hai and it exact product-added-to-cart count bhi nahi thi.

Observed test me landing session `sessions` schema se aa gayi while Product Page Views/Product Sessions zero rahe. Current view metrics `web_performance` schema ke page loads + `micro_session_id` se aate hain. Ye Core Web Vitals/page-load reporting source general sessions report ke saath same refresh timing guarantee nahi karta; Shopify documentation examples completed day (`endOfDay(-1d)`) use karte hain. Analytics overview normally about one minute me update hota hai, but some report/marketing data up to 24 hours le sakta hai. Current-day zeros ko automatically true zero assume nahi karna chahiye.

---

## 2026-08-13 — Configurable Product Audit report builder

Old Day/Week/Month picker replace karke custom start/end date range use kiya. Earliest selectable date current month se 18 months pehle wale full month ka first day hai. Example: Aug 13, 2026 par earliest Feb 1, 2025; latest Aug 13, 2026. Server URL parameters ko bhi isi boundary me clamp karta hai.

Analytics ShopifyQL queries daily grain par run hoti hain (`GROUP BY day` plus product/path identity). Browser selected Dimensions ke combination se rows group karta hai. Dimension list/order table ke left columns ka order decide karti hai. Available dimensions: Product ID, Title, Status, Type, Tags, Month, Week, Day. Serial-number column remove hai.

Default metrics: URL, Starting Inventory, Ending Inventory, Product Page Views, Product Sessions, Landing Sessions, Orders, Net Items Sold, Total Sales. Other existing metrics `+` picker se add ho sakti hain. Selected items me info tooltip, remove control aur drag/drop reorder hai. Export only currently selected dimensions/metrics and current order use karta hai.

Aggregation rules:

- Additive sales/session/unit metrics selected group ke daily values sum karte hain.
- Product Sessions daily unique counts add karte hain; cross-midnight same visitor double-count ho sakta hai, per approved daily-unique model.
- Starting Inventory group ki earliest available daily snapshot hai.
- Ending Inventory group ki latest available daily snapshot hai.
- Month full calendar month aur Week Monday-to-Sunday group label use karta hai.

Right-side Filters selected text dimensions par Contains/Equals aur numeric metrics par Equals/Greater than/Less than support karte hain. First version native browser date controls use karta hai; date behavior/range Shopify-style hai but dual-month calendar popup ka exact visual clone nahi hai.

## 2026-08-13 — Top report toolbar placement

Custom date range ko Product Audit page heading ke immediately neeche top toolbar me move kiya. Start/end controls and selected range left side hain; Export button same level par right side hai. Separate date-range section remove kiya. Narrow screens par toolbar items wrap karte hain.

## 2026-08-17 — Sortable report columns

Har selected Dimension aur Metric table header me up/down sort arrows add kiye. First click ascending aur second click descending karta hai; active direction dark arrow se identify hoti hai. Sorting complete filtered result set par pagination se pehle apply hoti hai, aur current-page/all-results exports same sorted order preserve karte hain. Text natural/numeric comparison, numeric metrics number comparison, aur date/time dimensions chronological comparison use karte hain. Blank values bottom par rehti hain.

### Arrow design and layout stability correction

Filled triangle characters ko screenshot-style thin outline SVG chevrons se replace kiya. Icon ka fixed 12px slot hai, so active direction change header width alter nahi karti. Table `table-layout: fixed` aur per-column fixed widths use karti hai; sorting se visible row content change hone par browser columns recalculate nahi karta, isliye table/right shift nahi hoti. Long cell/header content ellipsis me contain hota hai.

## 2026-08-17 — Shopify-style two-column report layout

Product Audit content ko desktop par two-column report layout me arrange kiya. Left flexible column me selected metric totals, product search aur products table hain. Right fixed-width column me Metrics, Dimensions aur Filters controls sticky hain, isliye table dekhte waqt report configuration simultaneously visible rehti hai.

Date controls apne existing white card me top-left rehte hain. Export action same top row par hai, lekin date card se bahar apne separate container me render hota hai. Small screens par both report columns ek vertical column me stack hote hain, so narrow embedded Shopify views me content squeeze nahi hota.

### Full-width and zoom-responsive correction

Shopify `s-page` ke centered content width ki wajah se browser ke 100% zoom par report grey workspace ka sirf beech wala hissa use kar rahi thi. Report content ko viewport-aware canvas diya gaya jo available embedded-app width use karta hai while keeping 32px spacing on each side.

Desktop/tablet widths par report builder right column me fixed rehta hai. Uski width viewport ke saath 300–360px ke beech adjust hoti hai aur height visible viewport ke barabar rehti hai; left totals/search/table normal page scroll ke saath move karte hain. Sirf 760px se chhoti mobile width par sidebar neeche stack hota hai. Metric cards available width ke according reflow karte hain, aur very wide view par four cards per row use hote hain so default eight totals generally two rows me fit hote hain.

### Product search section removed

Table ke upar ka separate Product Search section remove kiya gaya because right-side Filters already dimensions aur metrics par filtering provide karte hain. Left column ka visible order ab selected metric totals ke immediately baad products table hai.

### Independent Metrics and Dimensions scrolling

Metrics aur Dimensions ke selected-item lists ko separate vertical scroll areas diye gaye. Section heading aur `+` control list scroll karne par visible rehte hain. Metrics list 310px aur Dimensions list 250px tak expand hoti hai; uske baad each list apna scrollbar show karti hai, so all table-selected columns accessible rehte hain without making the complete sidebar excessively long.

Scrollbar width ko compact 6px style diya gaya. Metrics aur Dimensions list scrollbar gutter consistently preserve karti hain; Filters ko separate 260px maximum-height scroll area mila, jiska scrollbar sirf enough filter rows add hone par visible hota hai. Complete sticky sidebar scrollbar bhi same thin visual style follow karta hai.

### Collapsible whole-sidebar scrolling correction

Nested Metrics, Dimensions aur Filters scrollbars remove kiye gaye because multiple adjacent scroll tracks clean nahi lag rahe the. Har section ab collapsible dropdown hai: heading/chevron click karke complete selected list show ya hide hoti hai. Open section me all selected items render hote hain, aur scrolling sirf complete sticky right column par hoti hai. `+` buttons section heading ke saath independently available rehte hain.

### Shopify-style controls-panel viewport

Right controls column ko Shopify Analytics jaisa separate visible-height panel banaya gaya. Panel height viewport ke according 420–720px ke beech calculate hoti hai, so its scrollbar track and bottom viewport ke andar accessible rehte hain even though panel ShopifyQL debug section ke baad start hota hai. Panel ke right edge par always-present 8px scrollbar complete Metrics, Dimensions aur Filters content ko scroll karta hai; normal page scrollbar independently browser/app ke far-right par rehta hai.

### Full available-height correction

Fixed 420–720px panel restriction remove ki gayi. Browser ab right panel ke current visible top se viewport bottom tak exact available height calculate karta hai. Page scroll par sticky panel top ki taraf move hota hai toh height automatically expand hoti hai. Metrics, Dimensions aur Filters default expanded hain, all selected rows render karte hain, aur only complete right panel ka combined scrollbar use hota hai.

## 2026-08-17 — Metric totals inventory removal and unique Orders

Selected Metric Totals section inventory snapshot cards (`First Day in Inventory`, `Starting Inventory`, `Ending Inventory`) render nahi karta; these metrics table selection and product rows me available rehti hain.

Orders total ab per-product Orders column ka sum nahi hai. Separate cached ShopifyQL query `FROM sales SHOW orders` selected date range par store-level unique orders fetch karti hai. Ek order me multiple products hon toh table me each included product ke against order appear ho sakta hai, but top Orders total us order ko only once count karta hai.

### Result table Summary row

Table header ke immediately neeche sticky Summary row add ki gayi. First selected Dimension cell `Summary` show karti hai, remaining dimension cells blank hain. Numeric metric columns currently filtered resultant rows ka column total show karti hain; money store currency me format hota hai, date metrics earliest displayed date show karti hain, and text URL summary dash show karta hai. Orders summary product rows sum karne ke bajaye selected date range ka store-level unique Orders total use karti hai.

### Expanded filter operators

Numeric metrics support: Is, Is not, Between, Greater than, Less than, Greater than or equal to, and Less than or equal to. Between inclusive hai and two numeric inputs use karta hai.

Text dimensions/metrics support: Is, Is not, Is one of, Is not one of, Contains, Does not contain, Contains one of, Does not contain any of, Starts with, and Ends with. Multi-value operators comma-separated input accept karte hain and comparisons case-insensitive hain. Selected filter field change hone par compatible operator and empty values automatically reset hote hain.

## 2026-08-19 — Product Page Views and Product Sessions discarded

`Product Page Views` and `Product Sessions` metrics removed because Shopify's `web_performance` dataset did not consistently reconcile with product landing sessions and was not considered accurate enough for this audit report. The complete `FROM web_performance ... page_loads ... micro_session_id` request, per-request session-ID Sets, row fields, metric definitions, default selections, totals, filters, table columns and exports were removed.

`Landing Sessions` remains and continues to use the `sessions` schema grouped by day and `landing_page_path`. Removing the uncached `web_performance` request reduces live ShopifyQL work on every date-range load.

## 2026-08-17 — ShopifyQL automatic date-range splitting correction

Earlier implementation had bounded retry only; discussed date-range splitting source code me actually present nahi thi. `attempts: 3` therefore retry show karta tha but final rate-limit error ke baad same range smaller queries me break nahi hoti thi.

All five analytics query paths now whole range first attempt karte hain. Retry exhaustion par retryable error, ya 100,000-row truncation mile toh 2-second pause ke baad date range halves me recursively split hoti hai. Same dataset chunks sequentially run hote hain; separate datasets remain top-level parallel. Successful chunk rows concatenate hote hain because every granular table query day dimension use karti hai; ungrouped unique Orders chunks can be safely summed because each order belongs to one order date. Debug panel combined chunk count show karta hai.

Catalog timestamp analytics execution timestamp nahi hai. Debug label now explicitly separates `catalog last refreshed` from `report generated`. Catalog has six-hour TTL, so a 10:55 AM catalog timestamp at 3:46 PM is expected and still fresh.

## 2026-08-20 — Selected totals: unique orders and no inventory cards

The Selected metric totals area excludes First Day in Inventory, Starting Inventory, and Ending Inventory even when those metrics are selected for the table. Inventory remains available in the report itself.

The Orders card must not sum per-product order counts because one order containing multiple products would be counted once for each product. A separate ungrouped `FROM sales SHOW orders` query supplies the selected range's store-wide unique order total. The table keeps product-level order values. The aggregate table row label is `Summary`.

## 2026-08-20 — New Arrival Analysis placeholder page

A new authenticated embedded-app page is available at `/app/new-arrivals`. It is intentionally blank apart from the `New Arrival Analysis` page heading. The Python cohort repository remains separate while its requirements are reviewed before any logic is ported into the Shopify app.

# 2026-08-20 — New Arrival Analysis port

- The Python `cohort_engine.py` behavior is the source of truth; the older workbook script is not used for calculations.
- Default range is 15 calendar months including the current month. The current month ends at yesterday; selection is limited to the latest 18 calendar months.
- Shopify analytics is fetched one month at a time. Each month runs inventory, product sales, and store-total sales together; only two months are processed concurrently to reduce rate-limit pressure.
- Completed months use the existing analytics cache. Temporary Shopify failures retry three times with increasing pauses.
- Launch month remains the first month in the available input where starting inventory, ending inventory, or sales is positive.
- Cohort Details is paginated at 50 rows in the browser to avoid rendering thousands of wide rows at once. Calculations still use the full fetched dataset.

# 2026-08-31 — Conversion-focused landing page and command center

- Replaced the Shopify starter landing page with a purpose-built SecondLook acquisition experience focused on inventory risk, product demand, cohort quality, and fast Shopify connection.
- Avoided fabricated logos, testimonials, customer counts, and financial claims. Dashboard values are clearly part of a product interface preview rather than claimed merchant results.
- Kept Shopify domain authentication as the primary conversion action and removed unnecessary navigation and form friction.
- Replaced the embedded template home and its product-creation mutation with a read-only command center. Home now routes merchants to Product Audit, New Arrival Analysis, and Order Details.
- Day-1 activation is structured around running the first product audit and reviewing the first new-arrival cohort.
- Used route-scoped CSS and no new UI dependencies to preserve application performance and avoid affecting analytics routes.

# 2026-08-31 — Polaris light data-visibility refactor

- New Arrival focus modes are client-side views over the same loader result, so switching views causes no Shopify queries or cache writes.
- Cohort Details search, product type, stock status, and launch cohort filters run before pagination; sorting and export therefore apply to all matching products.
- Frozen product context was reduced to Product, Type, and Launch Cohort (approximately 405px). Product ID moved beneath the title and the title itself links to Shopify.
- Product thumbnails and handles are presentation metadata only. Existing analytics calculations and cache datasets remain unchanged.
- Export supports CSV, JSON Lines, and XML from the currently filtered Cohort Details result.
- Product Audit retained all existing report-builder behavior and received only Polaris light table-token overrides.

## 2026-08-31 — In-context cohort methodology

- Added calculation guidance directly to New Arrival Analysis instead of creating another route.
- The calculation drawer owns its open state, so opening or closing it does not reset table search, filters, sorting, pagination, focus mode, or density.
- Metric definitions and formulas now live beside `MATRIX_METRICS` and `DETAIL_METRICS`, keeping table labels, tooltips, and methodology tied to the same configuration.
- Header tooltips render through a document portal with fixed positioning so table overflow and sticky headers cannot clip them.

## 2026-08-31 — New Arrival sales basis

- `NA sales` uses Shopify `total_sales`, not gross sales.
- `NA Sales %` is cohort `total_sales` divided by store `total_sales` for the same month.
- The existing ShopifyQL queries and engine already used `total_sales`; the in-context definitions were corrected to match the calculation.

## 2026-08-31 — New Arrival classification and time dimensions

- New Arrival Analysis defaults to Product Type classification and Month grouping.
- Product Tag classification counts each product once in Overall, but includes a multi-tag product once in every tag category it carries.
- Week grouping uses Monday–Sunday periods. The first and last week are clamped to the selected custom dates.
- Products already active before the selected range are assigned to the first selected period, matching the existing monthly boundary rule.
- Weekly analytics are cached separately per week to preserve accurate starting and ending inventory and avoid mixing monthly and weekly cache entries.

## 2026-09-01 — Product Tag classification performance fix

- Shopify tag data was present and valid; the failure was caused by rendering every hidden tag matrix and returning empty cohort rows for all 385 tags.
- Collapsed classification matrices now mount their table only when the user expands them.
- Category matrices return only cohort rows that actually launched products. Overall remains complete across every selected period.
- On the current store, this reduced the tag report payload from 12.34 MB to 5.28 MB and report generation from about 1.7 seconds to about 0.77 seconds without removing real tag data.

## 2026-09-01 — Staged Product Tag loading with complete cohorts

- Product Tag mode initially returns Overall, tag names, and Cohort Details; individual tag matrices are requested separately from cached analytics.
- The first 20 tags are prepared in a staggered background queue, with at most two tag requests running simultaneously.
- Tags near the viewport, hovered, focused, or opened are prioritized. Other tags remain unloaded until required.
- Every loaded tag matrix includes every selected cohort row, including cohorts with no activity, to keep comparisons aligned.
- Full tag exports intentionally request all matrices only when Export is clicked; normal page loading remains staged.

## 2026-09-01 — Final category loading policy: click only

- Supersedes the earlier first-20, viewport, and hover preparation strategy.
- Both Product Type and Product Tag modes initially load Overall plus collapsed category names only.
- A category matrix is requested only when its section is opened. Closing and reopening uses the fetcher's in-page cached data.
- No hover, focus, viewport, or automatic background request can accidentally load categories while scrolling.
- Export remains independent: clicking Export requests all category matrices through `exportAll=1` and produces a complete report.

## 2026-09-01 — Custom New Arrival matrix columns

- Removed the Sales & Revenue, Inventory & Sell-Through, and Traffic & Conversion metric presets.
- Added one Custom Columns selector containing every matrix metric; all are selected by default.
- Users can show/hide metrics and drag the six-dot handle to reorder them. At least one metric remains selected to keep the matrix valid.
- The selected metric set and order apply consistently to Overall, click-loaded category matrices, and exports.

## 2026-09-01 — Explicit report processing states

- Date presets/forms and classification/interval controls now use React Router navigation, allowing the UI to detect pending report requests.
- During report navigation, the complete control card remains visible while stale content below it is replaced by a loading state.
- Matrix metric selection/reordering and Cohort Details filters show localized loaders while their affected view recalculates.
- Loaders do not clear the user's selected controls; they only replace the stale result region.

## 2026-09-01 — Weekly grouped fetching and presets

- Weekly analytics are requested in seven-week chunks instead of issuing four ShopifyQL requests for every individual week.
- Each chunk runs inventory, product sales/orders, store sales, and landing sessions together, grouped by ShopifyQL `week`; the returned rows are then separated into Monday–Sunday periods in the app.
- Chunks run sequentially to reduce Shopify rate-limit pressure. The four datasets inside one chunk still run in parallel for speed.
- If a grouped chunk reaches Shopify's 100,000-row result limit, only that chunk is automatically divided into smaller week groups and retried.
- Week mode defaults to the last five completed weeks plus the current week through yesterday. Presets provide 5, 8, or 12 completed weeks plus the current week.
- Switching to Week intentionally applies its default weekly range. The visible date inputs remount from the loader's accepted range so they cannot retain stale monthly dates.

## 2026-09-02 — Frozen New Arrival matrix summary

- The New Arrival Analysis matrix keeps both header rows and the Summary row fixed during vertical scrolling.
- Sticky offsets differ between Comfortable and Compact density so the Summary row sits directly beneath the headers without overlap.
- The Cohort column remains horizontally frozen, including where it intersects the sticky Summary row.

## 2026-09-04 — Uniform Cohort Details columns

- Cohort Details now defines its table columns explicitly through a `colgroup` instead of allowing browser content-based sizing.
- Every repeated monthly metric column uses the same width, so the same metric and neighboring metrics remain aligned across all month blocks.
- Product, classification, and launch-cohort columns retain their existing frozen widths.
- The table uses fixed layout and an exact width calculated from the number of periods, preventing `colspan` headers or spare container space from redistributing individual columns.
- Monthly metrics use 104px in Comfortable mode and 86px in Compact mode to display more report columns at once.

## 2026-09-04 — Continuous grouped-header separator

- Product, classification, and launch cohort retain semantic table headers, but their visual header is rendered as one dedicated opaque overlay above the frozen 405px region.
- The overlay uses browser-native `position: sticky` on both axes. JavaScript scroll-position synchronization was removed because fast scroll events could render one frame late and make the header jump before catching up.
- Product, classification, and launch cohort are visually merged across both header rows, with their labels vertically centered to match the approved reference.
- The Month-to-Metric divider intentionally starts after the 405px frozen region and is rendered as its own native sticky layer, so it stays visible while the month section scrolls vertically.
- The merged frozen overlay keeps only its lower header-to-body divider and sits above both data cells and adjacent headers.
- A negative bottom margin overlays the header on the table without adding blank vertical space; Comfortable and Compact modes use matching 84px and 68px values.

## 2026-09-04 — Stable single header divider

- Removed the separate sticky Month-to-Metric divider because it duplicated the table header border and the two layers changed paint position independently while scrolling.
- The month header cells now own one inset divider, so the same line remains visible before, during, and after vertical scrolling.
- Comfortable and Compact modes now define their month-row, metric-row, and combined header heights through shared CSS variables. This prevents one-pixel offset changes between the frozen overlay and native table headers.

## 2026-09-04 — Native frozen headers replace overlay

- The remaining scroll movement came from the frozen-column header overlay entering its sticky state independently from the table.
- Removed the overlay and negative-margin positioning completely.
- Product, classification, and launch cohort now use their real two-row table header cells. Those cells are sticky on both axes, opaque, and layered above scrolling month headers and body cells.
- All header cells and separator lines now share the table's coordinate system, eliminating the separate layer that could shift during sticky activation.

## 2026-09-10 — First-cohort retrospective activity rule

- Cohort assignment still uses the earliest displayed period with starting inventory, ending inventory, or Shopify Total Sales greater than zero.
- The first displayed cohort additionally checks a retrospective window beginning on the first day two complete calendar months before the selected start month and ending one day before the selected start date. For a report beginning August 15, the window is June 1 through August 14.
- A retrospective match moves a product into the first displayed cohort only if that product is also active somewhere inside the selected report range. Products active only before the range remain excluded.
- The same two-calendar-month rule applies to Month and Week grouping. In Week grouping, matched products are assigned to the first displayed weekly cohort.
- A carried product may be inactive in the first displayed period. Its cohort launch count still includes it, while that period's active product count does not; therefore first-cohort NA Product % can correctly be below 100%.
- Cohort assignment does not use Shopify `first_day_in_inventory`, so the displayed cohort can differ from the product's original inventory date.

## 2026-09-10 — Calculation drawer FAQs

- Added a collapsible FAQ section inside Calculation Logic & Formulas so methodology answers remain available without creating another page or overcrowding the drawer.
- FAQs explain a below-100% first-cohort NA Product %, delayed cohort assignment for older products, and the denominator difference between NA Product % and NA Product % (Total).
- Additional answers clarify that lookback-only products remain excluded and that Month and Week views use the same calendar-month lookback rule.
- The FAQ also explains that Product Type/Tag summary and cohort contribution percentages retain store-wide denominators; they are not percentages within the selected category and therefore need not total 100%.

## 2026-09-10 — Shared single-window date range picker

- Replaced separate native Start date and End date inputs on Product Audit and New Arrival Analysis with one shared Shopify-style range control.
- Opening the control creates a local draft range. Calendar selections do not change URL parameters or reload report data until Apply is clicked; Cancel, outside click, and Escape discard the draft.
- Month and Year selectors provide direct navigation before choosing an exact day, while arrow controls support adjacent-month movement.
- Each report retains its existing minimum and maximum date constraints. New Arrival Analysis also retains its interval-aware quick-range presets.
- Both pages use the same reusable component and scoped stylesheet so range interaction remains consistent.

## 2026-09-10 — Dual-calendar date range interaction

- Revised the shared range window to show two coordinated calendars: a dedicated Start date calendar on the left and End date calendar on the right.
- Each calendar displays its own selected value, preventing ambiguity about which boundary a date click changes.
- Clicking a calendar's Month/Year heading starts a guided Year → Month → Date selection flow. Outer arrows continue to support quick adjacent-month navigation.
- Start and end selections remain drafts inside the shared window and are still committed together only through Apply.
- On narrow screens the two calendars stack vertically inside a scrollable dialog while preserving the same selection behavior.
# 2026-09-11 - Compact dual-calendar navigation

- Each Start and End calendar now has its own paired previous/next month controls beside the month label.
- The shared picker was reduced in width and row height so it fits report screens without dominating the table.
- Weekday labels use single-letter initials to match the supplied report UI reference.
# 2026-09-11 - Quick-range semantics and lookback query

- Monthly quick ranges mean the requested number of previous complete calendar months plus the current partial month. For example, Last 12 months on Sep 11, 2026 covers Sep 1, 2025 through Sep 10, 2026.
- First-cohort lookback queries aggregate directly by product because cohort assignment only needs to know whether each product was active anywhere in that lookback window; month-level grouping was unnecessary and caused the inventory query to fail.
# 2026-09-11 - Simplified first-cohort explanation

- Replaced the technical lookback sentence in Calculation Logic with a plain-language explanation and an Aug 15 example covering Jun 1 through Aug 14.
- Clarified that lookback activity alone is insufficient: the product must also become active somewhere within the selected report range.
# 2026-09-11 - Calculation dictionary clarity

- Both report dictionaries now render from the exact matrix and cohort-detail metric definitions used by the table headers.
- CR % is described as a directional landing-session indicator, not an exact product conversion rate, because sessions that began elsewhere are outside its denominator.
- The drawer states the precise first-cohort lookback window and includes examples for ranges starting on the first or a later day of a month.
# 2026-09-11 - Calculation drawer section navigation

- The four top-level calculation sections are collapsed by default and use accessible native disclosure controls.
- Expanding or collapsing a section changes only the drawer presentation and does not reset report filters, sorting, or loaded data.
# 2026-09-11 - Remove stock-status filter

- Removed the Cohort Details stock-status filter because it was not required.
- Search, product type/tag, and launch cohort filters remain available.
# 2026-09-11 - Remove Order Details report

- Removed the standalone Order Details route, its navigation links, and its dedicated Shopify Admin GraphQL orders loader.
- Product-level Orders metrics in Product Audit and New Arrival Analysis remain because they are independent report calculations.
- Removed the exclusively-used SheetJS dependency to reduce installed and bundled code.
# 2026-09-11 - Chunk Product Audit inventory snapshots

- Product Audit inventory is fetched in non-overlapping seven-day chunks with at most two chunks in flight at once.
- Any chunk that still reaches ShopifyQL's 100,000-row cap is recursively split into smaller date ranges, down to a single day.
- Complete chunks are cached independently, allowing future overlapping report ranges to reuse existing inventory snapshots.
# 2026-09-11 - Align Product Audit date UX and navigation loading

- Product Audit now uses the New Arrival control hierarchy: date-range summary on the left and the shared dual-calendar trigger on the right.
- During date navigation, the prior report body is removed and replaced by a dedicated loading card while the date control remains visible and disabled.
- Export remains disabled until the new report resolves, preventing stale-range downloads.
# 2026-09-11 - Prevent Product Audit dimension regrouping freezes

- Replaced group arrays, per-group date sorting, and repeated per-metric reductions with one streaming aggregation pass.
- Dimension changes paint a loading state before applying the new grouping and keep the report body hidden until the computed result is ready.
- Date and export controls use the same busy state during both route loading and local dimension regrouping.

# 2026-09-14 - Product Audit pending range and inventory throttle recovery

- During route navigation, the date card now reads the pending URL range instead of retaining the previous loader range.
- Inventory chunk requests are lightly paced; cached chunks are not delayed.
- After ordinary query retries, only rate-limited inventory chunks are retried in two sequential recovery passes with longer shared cooldowns. Successful chunks are preserved and are not fetched again.

# 2026-09-14 - Unified New Arrival Excel workbook export

- Added a styled `.xlsx` export containing both `New Arrival Analysis` and `Cohort Details` worksheets.
- The analysis sheet exports Overall followed by every Product Type/Tag classification, including categories not opened in the UI, with merged period headers, metric headers and Grand Total rows.
- The details sheet exports product identity fields followed by merged month/week metric blocks, hyperlinks product URLs, and freezes the identity columns/header rows.
- ExcelJS is dynamically imported only when workbook export is requested, keeping the large spreadsheet library out of the normal page-load bundle.
- Existing CSV, JSON Lines and XML section exports remain available for backward compatibility.

# 2026-09-15 - Neutral zero-value cohort heatmaps

- Zero and missing percentage values no longer receive the low-performance red heatmap because zero is absence of measured performance, not a weak positive result.
- The low heatmap is now reserved for positive percentages below 5%; zero and missing values use subdued Polaris gray text.

# 2026-09-15 - Zero-shift product identification popover

- Cohort Details keeps its existing compact product column and row density while exposing full product information through a delayed hover/focus card.
- The card renders through a document-body portal with fixed positioning so table overflow and sticky columns cannot clip it.
- Product links reuse the live storefront URL already prepared for each report row, requiring no additional API request.

# 2026-09-16 - Single elevated product hover card

- Removed the product link's native HTML title tooltip so only the custom product card appears.
- Increased the card's opaque elevation and offset it from the product cell, keeping the pointer clear of its content while preserving viewport-safe horizontal placement.

# 2026-09-16 - Canonical storefront product links

- Product links now use only the shop's live primary domain plus the product handle; Shopify Admin URLs are no longer used as a fallback.
- The same canonical storefront URL is shared by the table, hover card, and all export formats so clicks and downloaded reports remain consistent.

# 2026-09-16 - Resilient Cohort Details product search

- Product search now normalizes case, punctuation, hyphens and repeated spacing before matching title, handle or Product ID.
- Full-title searches now tolerate visually similar but technically different separators, such as hyphens, Unicode dashes, non-breaking spaces and repeated whitespace.
- The query-prefix safeguard also handles a storefront title that legitimately extends the report title with an additional trailing code.
- Title matches now take priority over handle matches. This prevents a renamed product from appearing merely because its older URL handle still contains the searched title; handle and Product ID remain fallbacks when no title matches.
- Pasted storefront URLs are treated as explicit handle searches: the `/products/{handle}` segment is extracted and matched exactly instead of comparing the entire domain URL to a handle.

# 2026-09-16 - Supabase monthly analytics foundation

- Keep the existing Prisma/SQLite session and cache path active until the Supabase connection and first-store import are verified, avoiding a risky one-step production cutover.
- Persist compact product-month facts rather than daily facts. Product text and tags live in normalized tables so titles, URLs and tag classifications are not duplicated in every metric row.
- Store currency values in minor units as integers, retain exact store-level monthly totals for non-additive metrics such as unique orders, and omit permanent weekly facts during the Free-plan pilot.
- Enable row-level security without browser policies. Supabase access uses a server-only service-role secret and never exposes administrative credentials to Shopify Admin browser code.
- Reserve temporary weekly computation and expiring exports for later phases; first validate one store's actual row count, database size and report speed.

# 2026-09-17 - Shopify to Supabase monthly sync

- Added a separate authenticated sync resource without changing Product Audit or New Arrival report loaders.
- Sync the latest 18 calendar months from newest to oldest so recent data becomes available first and an interrupted run still provides useful progress.
- Fetch compact monthly product aggregates with at most two ShopifyQL requests in flight, retry temporary failures with exponential delays, and skip writing an incomplete month.
- Upsert product metadata, tags, product-month facts and store-month totals in batches of no more than 500 rows.
- Record running, completed, partial or failed status in `audit_sync_jobs`, including current month, completed months, failed months and rows written.
- Reject overlapping syncs for the same store and automatically close a running job as stale after two hours.
- Keep the current SQLite caches and live ShopifyQL reports as the source of truth until stored results have been compared and approved.

# 2026-09-18 - NA Inventory FAQ clarity

- Added separate FAQs for cohort NA Inventory and NA Inventory % so users do not interpret the denominator as a simple store-level inventory snapshot.
- Explain that a product contributes Ending Inventory in its assigned launch period and Starting Inventory in later periods.
- Explain that the percentage denominator applies the same product-level rule across all eligible store products, while Product Type/Tag sections retain that store-wide denominator.

# 2026-09-18 - Supabase catalogue pagination safeguard

- The first sync validation revealed repeated 1,000-product month counts even though ShopifyQL returned all 4,003 products.
- The limit came from Supabase PostgREST's default 1,000-row response size when the sync rebuilt its Shopify-ID-to-database-ID product map.
- Server-side Supabase reads now request consecutive 1,000-row ranges until the final partial page, preventing larger catalogues from being silently truncated.
- The sync runner accepts an explicit month list for targeted recovery, allowing failed rate-limited months to be retried without re-fetching successful months.
- Store-month `active_products` follows the report's activity rule rather than counting every stored product row: Starting Inventory, Ending Inventory or Total Sales must be greater than zero.

# 2026-09-18 - First-store Supabase reconciliation

- Reconciled May, July and August 2026 against fresh live ShopifyQL queries before enabling any database-backed report reads.
- Compared every identifiable product across inventory, first inventory day, landing sessions, orders, quantity metrics and all stored sales amounts; all fields matched with zero differences.
- Store-level active products, starting/ending inventory, unique orders, landing sessions and Total Sales also matched exactly for all three months.
- May ShopifyQL included one aggregate row without a Product ID. It is intentionally not stored as a product fact; all 4,001 identifiable May products matched.
- Keep both live reports on ShopifyQL until a separate, explicitly approved read-path rollout is implemented.

# 2026-09-28 - Store-scoped Supabase retention

- Retention cleanup now requires the database store ID and the oldest month to retain.
- Product-month and store-month deletes use `store_id = selected store AND month < cutoff`, preventing one store's sync from deleting another store's history.
- Cleanup fails safely when the store ID or cutoff date is missing or invalid.
- Automated coverage uses two stores and proves that cleaning Store A removes only Store A's expired rows while every Store B row remains unchanged.

# 2026-09-28 - Atomic Supabase store-month replacement

- Monthly sync persistence now sends the complete validated store-month to one server-only PostgreSQL function instead of independently upserting product and summary rows.
- The function validates store ownership first, deletes only the selected store/month, and inserts the complete replacement within one transaction.
- Products omitted from Shopify's newest complete month no longer leave stale historical rows behind.
- Any validation or insert error rolls back the entire function call, preserving the previous complete month rather than leaving a missing or partially refreshed month.

# 2026-09-28 - Authenticated store-scoped Supabase gateway

- Added one server-only analytics access layer that resolves store identity from the authenticated Shopify `session.shop` value.
- Sync code no longer manually supplies store filters for products, monthly facts, retention or sync jobs; the gateway applies the authenticated store automatically.
- Browser-provided store filters are not accepted. Even if a caller supplies a different store filter, the gateway removes it and uses the authenticated store ID.
- Product tags are checked against the scoped store's product IDs before replacement, covering the normalized tag table that intentionally has no `store_id` column.
- Cross-store tests exercise Store A and Store B gateways and verify isolation for reads, job updates, retention deletes and atomic month writes.

# 2026-09-29 - Non-negative reporting inventory totals

- Product-month Starting Inventory and Ending Inventory continue to store Shopify's original values, including negatives, so Product Audit and reconciliation do not lose source information.
- Store-month `non_negative_starting_inventory` and `non_negative_ending_inventory` add each product only after converting a negative balance to zero. A negative product can no longer reduce a store total.
- New Arrival Inventory and its denominator use the same shared non-negative rule before applying the existing launch-period rule: Ending Inventory in launch period, Starting Inventory afterward.
- The database also rejects negative store-month totals and the atomic replacement function clamps incoming summary totals, protecting future database-backed report readers and older callers.

# 2026-09-29 - Product Orders versus Store Unique Orders

- Product-level orders mean Product Orders: an order contributes once to every product it contains. They remain valid for product and cohort analysis but are not additive across products.
- The ungrouped store query and `audit_store_month_metrics.unique_orders` mean Store Unique Orders: each customer order contributes exactly once to the store total.
- Product Audit table headers and New Arrival dictionaries now say Product Orders. The selected total card says Store Unique Orders.
- Product Audit's cross-product Summary row no longer displays a summed Product Orders number; it shows `Not additive` and directs users to Store Unique Orders.
- Supabase product-month storage uses the explicit `product_orders` column. The replacement function temporarily accepts both `product_orders` and the older `orders` payload name so an older running sync cannot silently lose order values during rollout.

# 2026-09-29 - Product catalogue lifecycle and storage cleanup

- Keep Shopify's last reported `status` (`ACTIVE`, `DRAFT`, or `ARCHIVED`) and store a separate compact `catalog_state` (`present`, `missing`, or `deleted`).
- Product Audit database reads use a zero-storage view that exposes `effective_status`; `MISSING` and `DELETED` take priority over a stale last-known Shopify status.
- Lifecycle reconciliation always forces a fresh complete catalogue fetch. A cached or failed catalogue response is never used to mark products missing.
- Returned products become `present` and update `last_seen_at`. Products absent from that completed fetch become `missing` while retaining their title, status, tags, and monthly facts.
- Shopify `products/delete` webhooks mark deletion explicitly without deleting historical data.
- Tag replacement is limited to products returned in the fresh catalogue. Missing/deleted products retain their last-known tags for historical reports.
- After the rolling 18-month facts are cleaned, missing/deleted products with no remaining monthly facts and at least a 30-day grace period are deleted. Foreign-key cascades remove their tags without leaving orphan rows.
# 2026-09-29 — Historical product handles and landing-session reconciliation

- Product landing sessions are no longer matched only against the current Shopify handle.
- `audit_product_handle_history` records each known handle and its validity window. A full catalogue sync closes the old handle and opens the new one when a rename is detected.
- Existing products are seeded with their current handle. Renames that happened before this feature cannot be reconstructed automatically unless Shopify session results expose the old handle; those sessions are retained as unmatched instead of being silently discarded.
- `audit_unmatched_landing_sessions` stores unmatched product-handle counts by store and month. Ambiguous reused handles also stay unmatched to avoid assigning traffic to the wrong product.
- Store-month rows separately preserve matched product landing sessions, unmatched product landing sessions, and Shopify's direct store-wide session total. Existing `landing_sessions` remains the matched product value so current reports do not change.
- The additional direct store-session ShopifyQL query is for reconciliation only and is not substituted into product-level conversion calculations.
# 2026-09-30 — Monthly product metadata snapshots

- Historical database-backed reports will use the title, Product Type, and handle saved for each product-month instead of automatically joining those fields to today's catalogue values.
- Tags remain current-only and are intentionally not copied into monthly rows.
- The first snapshot saved for a product-month is preserved during later refreshes of that month. Metrics can be corrected without silently reclassifying historical results.
- Existing product-month rows are initialized with the current metadata available at migration time. Shopify does not provide a reliable reconstruction of every title/type/handle change that happened before snapshot tracking began.
- Current live ShopifyQL reports remain unchanged until the database-read switchover is separately implemented.
# 2026-09-30 — Atomic product-tag refresh

- A catalogue refresh now sends the complete refreshed product IDs and tag set to `replace_audit_product_tags` in one Supabase RPC.
- The database validates store ownership, refreshed-product membership, and non-empty tags before deleting anything.
- Delete and insert execute in one PostgreSQL transaction. Any failure automatically restores the previous correct tags.
- Only products included in the successful fresh catalogue response are replaced; missing/deleted products keep their historical last-known tags.
# 2026-09-30 — Monthly currency history and cross-store safety

- Both product-month and store-month money rows now store their own three-letter `currency_code`.
- Existing rows are initialized from their owning store's current currency. Future rows receive the currency returned by Shopify for that sync.
- A resync cannot replace an existing month with a different currency. The previous good month remains intact until an explicit conversion policy exists.
- Cross-store totals must group by currency. INR, USD, GBP, or any other currencies must never be added directly.
- A future agency dashboard requires an explicitly selected reporting currency, an exchange-rate source, a rate date policy, and stored conversion evidence before displaying converted totals.
# 2026-09-30 — Store-timezone calendar boundaries

- The sync fetches Shopify's `ianaTimezone` together with currency and stores it as `audit_stores.iana_timezone`.
- “Today”, “yesterday”, latest completed month, month end, ShopifyQL `SINCE`/`UNTIL`, and sync-job range end are calculated from the store's local calendar rather than the app server clock.
- IANA timezone conversion uses `Intl.DateTimeFormat`, so daylight-saving transitions are handled by the runtime timezone database.
- Missing legacy timezone values default to `Etc/UTC`; the next authenticated full sync replaces that fallback with Shopify's actual timezone.

# 2026-09-30 - Clear sync progress metrics

- `job_attempt` records attempts of the complete sync job, while `query_retry_count` records extra ShopifyQL query executions caused by retry handling.
- `rows_processed`, `rows_inserted`, `rows_updated`, and `rows_deleted` now have separate meanings and are updated after each completed operation.
- Atomic tag refresh, store-month replacement, and retention cleanup return their real insert/delete counts from PostgreSQL instead of reporting only payload size.
- `error_summary` stores a short one-line operational message. The existing `error_message` remains available for compatibility and fuller diagnostics.
- Legacy `attempts` mirrors `job_attempt`, and legacy `rows_written` mirrors inserted plus updated rows so older readers continue working.

# 2026-09-30 - Shopify IDs remain text

- Shopify Product IDs are stored and compared as decimal text from API input through JavaScript and Supabase.
- Internal database keys such as `audit_stores.id`, `audit_products.id`, and monthly `product_id` foreign keys remain numeric bigint values.
- GraphQL GIDs are reduced to their trailing decimal text without converting through JavaScript `Number`.
- Unsafe numeric input is rejected instead of being silently rounded. Product-delete webhooks prefer Shopify's string `admin_graphql_api_id` value.

# 2026-09-30 - One unattributed Shopify data bucket per store

- Keep one protected synthetic product named `Unattributed Shopify Data` for each store when ShopifyQL returns sales or inventory without a usable Product ID.
- Mark it with `record_kind = unattributed`, Product Type `Unknown`, and effective status `UNATTRIBUTED`. It has no Shopify Product ID, storefront URL, handle, tags, or launch date.
- Show its source metrics in Product Audit and exports so product-level totals can be reconciled with Shopify instead of silently dropping the values.
- Show an `Unattributed` row in New Arrival Overall Analysis, plus `Unknown` Product Type or `None` Product Tag analysis, but expose only its sales trajectory and store-sales share.
- Never count the synthetic row as a product, active product, launch cohort, NA Product, or inventory denominator. Its landing sessions and conversion rate remain unavailable because no trustworthy product handle exists.
- Include its sales in the New Arrival grand sales total for reconciliation, while leaving all real-product counts, inventory, cohort, and conversion calculations unchanged.
- Exclude the synthetic row from catalogue missing/deleted reconciliation, delete webhooks, tags, handle history, active-product counts, and orphan-product cleanup.
- Store at most one such row per store with a partial unique database index. Monthly retention may remove old facts normally, but the small identity row remains available for future unattributed months.

# 2026-10-01 - Clear store inventory validation names

- Renamed only the store-month summary columns to `non_negative_starting_inventory` and `non_negative_ending_inventory`.
- Product-month `starting_inventory` and `ending_inventory` keep their original names and continue storing Shopify's raw per-product values, including negatives.
- The renamed store fields are calculated validation totals: each product's negative balance becomes zero before the values are added.
- These store totals are not the NA Inventory % denominator. NA Inventory continues to use product-level Ending Inventory in the launch period and Starting Inventory in later periods.
- The replacement database function temporarily accepts the previous store payload names as a compatibility fallback, while current application writes use only the new explicit names.

# 2026-10-01 - Product terminology for New Arrival counts

- New Arrival product-count metrics use `NA Products`, `NA Product %`, and `NA Product % (Total)` in the UI, formulas, FAQs, and exports.
- Internal report fields use `naProducts`, `naProductRate`, `naProductTotalRate`, `activeProducts`, and `launchedProductCounts` so the calculation vocabulary matches the displayed vocabulary.
- This is a terminology-only change. A product is still counted once by Product ID, and all existing count and percentage formulas remain unchanged.

# 2026-10-03 - Analytics storage routing foundation

- Stop assigning new stores to PostgreSQL analytics storage when projected usage would exceed 80% of the configured database allowance. With the current 500 MB allowance, the soft limit is 400 MB.
- Reserve mature 18-month capacity rather than relying only on today's database size. The initial estimate is 15 KB per Shopify product with an 8 MB minimum per store, based on the measured current-store footprint.
- Assign each store one fixed `database` or `file_cache` mode. Normal onboarding can increase a store's reservation as its catalogue grows, but cannot switch its mode.
- Provide a separate service-role-only migration function for a deliberate future move between modes.
- Serialize assignment decisions inside PostgreSQL so simultaneous installations cannot reserve the same remaining capacity.
- Step 1 did not change live report reads. Its temporary hold before database fact writes was removed when the private compressed-file pipeline below was implemented.

# 2026-10-03 - Private monthly file cache with browser acceleration

- Stores assigned to `file_cache` use the private Supabase Storage bucket `analytics-monthly-cache`; the bucket is never public.
- Store data is separated by the internal store ID. Each month is an independent gzip-compressed JSON file, with a compressed catalog and a small manifest alongside it.
- The manifest is published only after a complete month file upload, so browsers never discover a partly written month.
- Monthly files are self-contained and preserve Shopify IDs as text, product metadata, tags, inventory, sales, sessions, unattributed metrics, and store-level reconciliation totals.
- Only the authenticated server can use the Supabase service-role key. The browser requests a manifest or month through `/app/analytics-cache`, which derives store ownership from the Shopify session.
- File-cache stores keep their manifest and downloaded months in browser IndexedDB. Only files whose checksum changed are downloaded again, and expired months are removed locally.
- Existing database-mode stores and current live report reads remain unchanged. Connecting report calculations to this storage-neutral monthly format is a separate controlled step.

# 2026-10-03 - Automatic 18-month onboarding sync and Product Audit monthly reads

- Start the initial 18-month analytics sync automatically after an authenticated store opens the app and receives its fixed `database` or `file_cache` assignment.
- Treat the initial sync as complete only when all 18 months finish under the current cache schema version. A running sync is polled instead of starting a duplicate job, and an incomplete or older-format sync is retried on a later app opening.
- Product Audit is the first report connected to the storage-neutral monthly source because its month-level calculations can be compared directly with the existing ShopifyQL output before New Arrival Analysis is changed.
- Use saved monthly data only when every requested calendar month is present, complete, and compatible. Never combine a partly cached range with live data.
- Keep ShopifyQL as the safe fallback for current/partial months, missing cache coverage, old cache versions, errors, and any report using Day or Week detail.
- Preserve one report adapter for both storage modes: database stores read through an authenticated store-scoped Supabase RPC, while file-cache stores read their private catalog and month files through the server.
- Add completed-checkout sessions to the monthly product fact so the saved source can reproduce Product Audit's conversion metric without changing the existing formula.
- Keep New Arrival Analysis on its existing live path until Product Audit figures have been validated on refreshed versioned data.

# 2026-10-07 - Resumable preparation, selective upgrades, and daily refresh

- Product Audit and New Arrival Analysis now receive first priority when the app opens. Saved-data preparation waits until the visible report finishes its initial load, instead of competing with that report immediately.
- The initial 18-month preparation runs as 18 independent month steps from newest to oldest. A completed month remains complete, so closing the app or hitting a temporary Shopify error does not restart earlier months.
- Readiness is calculated from actual month coverage and cache version, not merely from the status of the latest sync job.
- Existing completed historical database months created before cache schema version 1 keep their inventory, sales, orders, currency, and metadata. They run a smaller selective upgrade that fetches only product landing/completed-checkout sessions and direct store sessions.
- The current month always receives a complete refresh when its covered end date is old. This prevents newly arrived sales or inventory from being incorrectly marked complete after a session-only upgrade.
- A month that does not exist still uses the complete five-dataset ShopifyQL fetch. File-cache months also use complete monthly files because they cannot be safely patched in place.
- Once all required months are ready, normal 18-month retention cleanup runs. Product Audit keeps its safe ShopifyQL fallback whenever saved coverage is incomplete.
- A protected `/api/analytics-cron` endpoint refreshes the current month after 5:00 AM in each store's own timezone. It processes one store per call to keep execution bounded and uses the same safe month-replacement pipeline.
- GitHub Actions wakes the shared Render service at 4:55 AM Asia/Kolkata through `/health`, starts the India morning refresh at 5:00 AM, and keeps the hourly timezone-aware check for stores in other regions. The refresh still has cold-start retries as a fallback. It requires a deployed, reachable app plus `ANALYTICS_CRON_URL` and `ANALYTICS_CRON_SECRET` repository secrets; local `shopify app dev` alone cannot receive reliable unattended scheduled calls.
- No report formula was changed. These changes alter when and how monthly source data is prepared, not the Product Audit or New Arrival calculations.

# 2026-10-07 - Render Free hosting foundation

- Use one Render Docker web service in Singapore so the app server is geographically close to the existing Supabase project in Seoul.
- Keep Render stateless. Free Render files disappear on sleep, restart, or redeploy, so Shopify online/offline sessions are stored in the existing Supabase project instead of relying on local SQLite.
- The Supabase session table is server-only: browser roles have no permissions, and only the service-role key can read access tokens.
- Keep the existing local Prisma SQLite store as a temporary cache and one-time session migration fallback. Losing it can reduce cache speed but cannot remove the persistent Shopify login stored in Supabase.
- Expose `/health` without Shopify authentication for Render deployment health checks.
- Bind the container to `0.0.0.0:3000`, with Render configured to provide `PORT=3000`.
- Disable Render automatic deployment. A GitHub commit does not change the live app until a deliberate manual deployment is approved.
- Keep the GitHub Actions daily-refresh scheduler because Render cron jobs are not part of the free web-service plan. The workflow retries while a sleeping free service wakes up.
- Render Free is suitable for development and early testing, but its idle sleep can make the first request take about a minute. A paid always-on service is recommended before Shopify review or a larger merchant rollout.

# 2026-10-08 - New Arrival monthly saved-data reads

- New Arrival Analysis uses the same storage-neutral monthly source as Product Audit when the complete visible range and its two-month first-cohort lookback are available under the current cache schema.
- The two lookback months are used only to carry previously active products into the first visible cohort; they never appear as visible report columns.
- Saved database reports read the direct store-month Total Sales through the authenticated, store-scoped analytics gateway so NA Sales % keeps its existing Shopify store-total denominator.
- Month requests fall back as one unit to the existing ShopifyQL flow when the selected start is not the first of a month, coverage is incomplete, the current month is stale, or any saved read fails. Week reports remain on ShopifyQL.
- Current catalogue title, type, tags, handle and image remain the report classification inputs. Stored historical metadata snapshots remain available for a future explicitly selected historical-classification mode.
- July through September 2026 saved inputs and the May through June cohort lookback were reconciled against fresh ShopifyQL. There were zero relevant mismatches across 340,272 values. One unattributed May first-inventory date was intentionally absent because unattributed rows do not participate in product, inventory, conversion or cohort calculations.
- Direct ShopifyQL store Total Sales matched the saved denominator exactly for July, August and September 2026.

# 2026-10-08 - New Arrival first-load speed and stable pending range

- Show the destination New Arrival shell as soon as navigation begins, using the same range normalizer as the server loader. The previous Product Audit date range must not remain visible while the New Arrival loader is pending.
- Use a dedicated service-role-only Supabase function for New Arrival reads. It returns only current product metadata, tags, the six monthly facts used by the report, and store-month coverage/totals instead of Product Audit's wider payload.
- Keep title, product type, and handle snapshots stored in the database, but do not transfer them for the current-classification New Arrival report. This preserves the approved report behavior and leaves snapshots available for a future historical-classification mode.
- Defer the large Cohort Details array until the merchant opens that tab. Category matrices and details reuse a five-minute, store-and-range-scoped server memory cache.
- Benchmark on the 24,282-row default report reduced the Supabase payload from 14.5 MB to 5.3 MB, the saved-data read from about 6.2 seconds to about 4.0 seconds, and the initial report JSON from 2.9 MB to about 0.03 MB.
- Full generated-report comparison confirmed identical overall matrices, category ordering, cohort details, and 4,003-product count between the compatible and optimized paths.

# 2026-10-08 - New Arrival production performance telemetry

- Emit structured `analytics_performance` entries to Render for each New Arrival server request, covering saved-source loading, report construction, total loader time, response size, and source-row count.
- Correlate the initial server entry with a second authenticated browser-ready entry through a random request ID. This separates database/report time from transfer, hydration, and browser rendering time.
- Record only bounded operational metadata: timing, range, interval, request kind, source class, cache status, row count, and response size. Never record store domains, product IDs, titles, tags, handles, access tokens, or query strings.
- The browser telemetry action does not revalidate the app or New Arrival loaders, so measuring a report can never trigger another report calculation.
- A duration of five seconds or more is written as a warning so slow production loads are easy to filter in Render logs.
