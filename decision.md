# Audit Bot — Decision Log

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
