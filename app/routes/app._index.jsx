import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import styles from "../styles/app-home.module.css";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  return { shop: String(session.shop || "").replace(/\.myshopify\.com$/i, "") };
};

function BrandMark() {
  return <span className={styles.brandMark} aria-hidden="true"><i /><i /><i /></span>;
}

function Arrow() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h11m-4-4 4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

const reports = [
  { href: "/app/products", label: "PRODUCT INTELLIGENCE", title: "Run a product audit", copy: "Find inventory, demand, conversion, and revenue signals against every Product ID.", accent: "violet", metric: "01" },
  { href: "/app/new-arrivals", label: "COHORT ANALYSIS", title: "Review new arrivals", copy: "See which launches sustain sales and sessions after their first month in market.", accent: "cyan", metric: "02" },
  { href: "/app/order-details", label: "ORDER EXPLORER", title: "Inspect order details", copy: "Trace product-level order performance without rebuilding another spreadsheet.", accent: "emerald", metric: "03" },
];

export default function CommandCenter() {
  const { shop } = useLoaderData();
  const today = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(new Date());
  return <s-page heading="Command Center"><div className={styles.shell}>
    <div className={styles.ambient} />
    <header className={styles.hero}>
      <div><div className={styles.micro}><span className={styles.pulse} /> STORE CONNECTED · {shop.toUpperCase()}</div><h1>Good to see you.<br /><span>What needs attention today?</span></h1><p>{today} · Your product intelligence workspace is ready.</p></div>
      <a className={styles.primary} href="/app/products">Run product audit <Arrow /></a>
    </header>

    <section className={styles.signalBar} aria-label="System status">
      <div><span className={styles.statusIcon}><i /></span><p><b>Analytics pipeline ready</b><small>Shopify data loads securely when you open a report.</small></p></div>
      <div className={styles.signalMeta}><span>DATA SOURCE <b>SHOPIFY</b></span><span>STATUS <b className={styles.healthy}>HEALTHY</b></span></div>
    </section>

    <section className={styles.workspace}>
      <div className={styles.sectionHeading}><div><span>START HERE</span><h2>Choose your next decision</h2></div><p>Every report is built to answer a specific operator question—not add another dashboard to maintain.</p></div>
      <div className={styles.reportGrid}>{reports.map((report) => <a key={report.href} href={report.href} className={`${styles.reportCard} ${styles[report.accent]}`}><div className={styles.cardTop}><span>{report.label}</span><b>{report.metric}</b></div><div className={styles.visual}><div className={styles.visualGrid}>{[0,1,2,3,4,5,6,7].map((item) => <i key={item} />)}</div><div className={styles.visualLine}><i /><i /><i /><i /><i /></div></div><h3>{report.title}</h3><p>{report.copy}</p><div className={styles.cardAction}>Open report <Arrow /></div></a>)}</div>
    </section>

    <section className={styles.activationGrid}>
      <article className={styles.checklist}>
        <div className={styles.panelHeading}><div><span>DAY-1 ACTIVATION</span><h2>Get to your first insight</h2></div><strong>1 / 3</strong></div>
        <div className={styles.progress}><i /></div>
        <ol><li className={styles.done}><span>✓</span><div><b>Connect Shopify store</b><small>{shop}.myshopify.com is authenticated</small></div></li><li><span>2</span><div><b>Run your first product audit</b><small>Choose a date range and identify products requiring action</small></div><a href="/app/products"><Arrow /></a></li><li><span>3</span><div><b>Review a new-arrival cohort</b><small>Compare launch quality across the last 15 months</small></div><a href="/app/new-arrivals"><Arrow /></a></li></ol>
      </article>
      <aside className={styles.operatorNote}><div className={styles.noteIcon}><BrandMark /></div><span>OPERATOR PLAYBOOK</span><h2>Start with the money already trapped in your catalogue.</h2><p>Open Product Audit, sort by ending inventory, then compare sales and landing sessions. Products with high stock and weak demand are your fastest route to an actionable decision.</p><a href="/app/products">Find at-risk inventory <Arrow /></a></aside>
    </section>

    <footer className={styles.footer}><span><BrandMark /> Audit Bot</span><p>Built for decisive Shopify operators.</p><div><i /> Systems operational</div></footer>
  </div></s-page>;
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
