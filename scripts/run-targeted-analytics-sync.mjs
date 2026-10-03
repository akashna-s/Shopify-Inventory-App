import { readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { createServer } from "vite";

function parseEnvironment(source) {
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

parseEnvironment(await readFile(".env", "utf8"));
// Shopify CLI normally injects the temporary tunnel URL. This standalone
// validation runner only needs a syntactically valid URL to construct the
// existing server client; it does not register or redirect to this value.
process.env.SHOPIFY_APP_URL ||= "https://localhost";

const months = process.argv.slice(2).filter((value) => /^\d{4}-\d{2}$/.test(value));
if (!months.length) {
  throw new Error("Provide one or more YYYY-MM months for the targeted validation sync.");
}

const baseUrl = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!baseUrl || !serviceKey) throw new Error("Supabase server credentials are required.");
const response = await fetch(
  `${baseUrl}/rest/v1/audit_stores?select=shop_domain&order=id.asc&limit=1`,
  {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
  },
);
if (!response.ok) throw new Error(`Could not read the verification store (${response.status}).`);
const [store] = await response.json();
if (!store?.shop_domain) throw new Error("No analytics store exists for validation.");

const vite = await createServer({
  appType: "custom",
  logLevel: "error",
  server: { middlewareMode: true },
});
try {
  const { syncLatest18MonthsToSupabase } = await vite.ssrLoadModule(
    "/app/shopify-supabase-sync.server.js",
  );
  const prisma = new PrismaClient();
  const session = await prisma.session.findFirst({
    where: { shop: store.shop_domain, isOnline: false },
    orderBy: { expires: "desc" },
  });
  if (!session?.accessToken) {
    await prisma.$disconnect();
    throw new Error("No offline Shopify session is available. Open the development app once and retry.");
  }
  const admin = {
    async graphql(query, { variables } = {}) {
      const response = await fetch(`https://${store.shop_domain}/admin/api/2026-07/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": session.accessToken,
        },
        body: JSON.stringify({ query, variables }),
      });
      if (!response.ok) {
        throw new Error(`Shopify Admin API returned HTTP ${response.status}.`);
      }
      return response;
    },
  };
  const result = await syncLatest18MonthsToSupabase(
    admin,
    session,
    { months },
  );
  console.log(
    `Targeted validation sync ${result.status}: ${result.completedMonths.length} completed, ${result.failedMonths.length} failed.`,
  );
  if (result.failedMonths.length) {
    for (const failure of result.failedMonths) {
      console.log(`${failure.month}: ${failure.error}`);
    }
    process.exitCode = 2;
  }
  await prisma.$disconnect();
} finally {
  await vite.close();
}
