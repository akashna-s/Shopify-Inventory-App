import { redirect, Form, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import styles from "./styles.module.css";

/* Small presentational components receive static local content. */
/* eslint-disable react/prop-types */

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) throw redirect(`/app?${url.searchParams.toString()}`);
  return { showForm: Boolean(login) };
};

const Icon = ({ children }) => <span className={styles.icon}>{children}</span>;

function ArrowIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h11m-4-4 4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function BrandMark() {
  return <span className={styles.brandMark} aria-hidden="true"><span /><span /><span /></span>;
}

export default function PublicLandingPage() {
  const { showForm } = useLoaderData();
  return <main className={styles.page}>
    <div className={styles.ambientOne} /><div className={styles.ambientTwo} />
    <nav className={styles.nav} aria-label="Main navigation">
      <a className={styles.brand} href="#top"><BrandMark /><span>Audit Bot</span></a>
      <div className={styles.navLinks}><a href="#product">Product</a><a href="#workflow">How it works</a><a href="#outcomes">Outcomes</a></div>
      <a className={styles.navCta} href="#start">Start free <ArrowIcon /></a>
    </nav>

    <section id="top" className={styles.hero}>
      <div className={styles.eyebrow}><span className={styles.pulse} /> Built for high-velocity Shopify teams</div>
      <h1>Find the products quietly<br /><span>draining your growth.</span></h1>
      <p>Audit Bot turns fragmented Shopify inventory, sales, sessions, and cohort data into one decisive operating view—so you can act before margin gets trapped in stock.</p>
      <div className={styles.heroActions}><a className={styles.primaryCta} href="#start">Audit my store <ArrowIcon /></a><a className={styles.secondaryCta} href="#product">See the command center</a></div>
      <div className={styles.trustRow}><span>✓ No spreadsheets</span><span>✓ Shopify-native data</span><span>✓ Actionable in minutes</span></div>

      <div id="product" className={styles.productFrame}>
        <div className={styles.windowBar}><div className={styles.dots}><i /><i /><i /></div><span>auditbot.app / command-center</span><div className={styles.liveBadge}><i /> LIVE</div></div>
        <div className={styles.dashboard}>
          <aside className={styles.mockSidebar}><div className={styles.mockLogo}><BrandMark /> Audit Bot</div>{["Overview", "Product audit", "New arrivals", "Order details"].map((item, index) => <div key={item} className={index === 1 ? styles.mockActive : ""}><span className={styles.sideGlyph} />{item}</div>)}</aside>
          <div className={styles.mockMain}>
            <div className={styles.mockHeader}><div><small>PRODUCT INTELLIGENCE</small><h3>Inventory Command Center</h3></div><button>Export report</button></div>
            <div className={styles.metricGrid}><article><small>NET SALES</small><strong>₹38.9L</strong><em>↗ 18.4%</em></article><article><small>LANDING SESSIONS</small><strong>142,806</strong><em>↗ 11.2%</em></article><article><small>AT-RISK STOCK</small><strong>287 SKUs</strong><em className={styles.risk}>₹12.4L exposed</em></article><article><small>NEW ARRIVAL CR</small><strong>3.82%</strong><em>↗ 0.6%</em></article></div>
            <div className={styles.dataPanel}><div className={styles.panelTop}><span>Product performance</span><div><i />Synced just now</div></div><div className={styles.tableHead}><span>PRODUCT</span><span>INVENTORY</span><span>SESSIONS</span><span>ORDERS</span><span>SALES</span><span>STATUS</span></div>{[
              ["Metallic linen sari", "318", "12,402", "384", "₹8.2L", "Scaling"], ["Ashmita bangle set", "42", "8,918", "201", "₹4.4L", "Reorder"], ["Patola modal silk sari", "1,204", "3,102", "39", "₹1.1L", "At risk"], ["Vetiver fragrance", "86", "4,860", "112", "₹3.3L", "Healthy"]
            ].map((row, index) => <div className={styles.tableRow} key={row[0]}>{row.map((cell, cellIndex) => <span key={cell} className={cellIndex === 5 ? styles[`status${index}`] : ""}>{cell}</span>)}</div>)}</div>
          </div>
        </div>
      </div>
    </section>

    <section id="outcomes" className={styles.outcomeStrip}><p>ONE OPERATING LAYER FOR</p><div><span>Inventory health</span><i /><span>Product demand</span><i /><span>New arrival cohorts</span><i /><span>Order intelligence</span></div></section>

    <section className={styles.section}>
      <div className={styles.sectionIntro}><small>THE OPERATOR ADVANTAGE</small><h2>Move from reporting<br />to decisions.</h2><p>Your store already produces the signal. Audit Bot removes the noise and puts the products requiring action at the top.</p></div>
      <div className={styles.featureGrid}>
        <article><Icon>01</Icon><h3>See every product clearly</h3><p>Connect sales, inventory, landing sessions, orders, and conversion against the same Product ID.</p><div className={styles.miniBars}><i /><i /><i /><i /><i /></div></article>
        <article><Icon>02</Icon><h3>Know what to scale</h3><p>Track new-arrival cohorts month over month and see which launches sustain demand after the first spike.</p><div className={styles.cohorts}><span>Jun NA <b>82%</b></span><span>Jul NA <b>64%</b></span><span>Aug NA <b>41%</b></span></div></article>
        <article><Icon>03</Icon><h3>Catch risk before it compounds</h3><p>Expose slow inventory, weak conversion, and products consuming cash without producing enough demand.</p><div className={styles.riskSignal}><span>!</span><div><b>287 SKUs need attention</b><small>Prioritized by revenue impact</small></div></div></article>
      </div>
    </section>

    <section id="workflow" className={styles.workflow}>
      <div><small>FROM DATA TO ACTION</small><h2>Your morning audit.<br />Without the manual work.</h2></div>
      <ol><li><b>01</b><div><h3>Connect your Shopify store</h3><p>Audit Bot reads the commerce data you already own. No spreadsheet uploads or fragile formulas.</p></div></li><li><b>02</b><div><h3>Choose the decision window</h3><p>Audit a custom date range, inspect product performance, or review new-arrival cohorts over time.</p></div></li><li><b>03</b><div><h3>Act on the signal</h3><p>Sort, filter, and export the exact products your growth, merchandising, and inventory teams need.</p></div></li></ol>
    </section>

    <section id="start" className={styles.finalCta}>
      <div className={styles.finalGlow} /><small>YOUR STORE IS ALREADY TELLING YOU WHAT TO DO NEXT</small><h2>Turn product data into<br /><span>profitable decisions.</span></h2><p>Enter your Shopify domain to open Audit Bot and run your first product audit.</p>
      {showForm && <Form className={styles.form} method="post" action="/auth/login"><label><span className={styles.srOnly}>Shop domain</span><input name="shop" type="text" autoComplete="url" placeholder="your-store.myshopify.com" aria-label="Shop domain" required /></label><button type="submit">Start free <ArrowIcon /></button></Form>}
      <span className={styles.formHint}>Secure Shopify authentication · No credit card required to connect</span>
    </section>
    <footer className={styles.footer}><a className={styles.brand} href="#top"><BrandMark /><span>Audit Bot</span></a><p>Product intelligence for ambitious Shopify operators.</p><span>© {new Date().getFullYear()} Audit Bot</span></footer>
  </main>;
}
