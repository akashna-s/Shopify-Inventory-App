import prisma from "./db.server";

const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const BULK_POLL_MS = 1000;
const BULK_TIMEOUT_MS = 90 * 1000;
const refreshesByShop = new Map();

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchProductsWithPagination(admin) {
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
            node { id title productType tags handle createdAt status }
          }
          pageInfo { hasNextPage }
        }
      }`,
      { variables: { cursor } },
    );
    const json = await response.json();
    if (json.errors?.length) throw new Error(json.errors[0].message);
    const edges = json.data?.products?.edges || [];
    products.push(...edges.map((edge) => edge.node));
    hasNextPage = json.data?.products?.pageInfo?.hasNextPage || false;
    cursor = edges.at(-1)?.cursor || null;
    pages += 1;
  }
  return products;
}

async function fetchProductsWithBulkOperation(admin) {
  const bulkQuery = `{
    products {
      edges {
        node { id title productType tags handle createdAt status }
      }
    }
  }`;
  const startResponse = await admin.graphql(
    `#graphql
    mutation StartProductAuditBulkExport($query: String!) {
      bulkOperationRunQuery(query: $query) {
        bulkOperation { id status }
        userErrors { field message }
      }
    }`,
    { variables: { query: bulkQuery } },
  );
  const startJson = await startResponse.json();
  const payload = startJson.data?.bulkOperationRunQuery;
  const startError = startJson.errors?.[0]?.message || payload?.userErrors?.[0]?.message;
  if (startError || !payload?.bulkOperation?.id) throw new Error(startError || "Could not start product bulk export.");

  const operationId = payload.bulkOperation.id;
  const deadline = Date.now() + BULK_TIMEOUT_MS;
  let downloadUrl = null;

  while (Date.now() < deadline) {
    await wait(BULK_POLL_MS);
    const pollResponse = await admin.graphql(
      `#graphql
      query ProductAuditBulkExportStatus($id: ID!) {
        bulkOperation(id: $id) { id status errorCode url partialDataUrl objectCount }
      }`,
      { variables: { id: operationId } },
    );
    const pollJson = await pollResponse.json();
    if (pollJson.errors?.length) throw new Error(pollJson.errors[0].message);
    const operation = pollJson.data?.bulkOperation;
    if (operation?.status === "COMPLETED") {
      downloadUrl = operation.url;
      break;
    }
    if (["FAILED", "CANCELED", "EXPIRED"].includes(operation?.status)) {
      throw new Error(`Product bulk export ${operation.status.toLowerCase()}: ${operation.errorCode || "unknown error"}`);
    }
  }

  if (!downloadUrl) throw new Error("Product bulk export did not finish within 90 seconds.");
  const download = await fetch(downloadUrl);
  if (!download.ok) throw new Error(`Could not download product bulk export (${download.status}).`);
  const text = await download.text();
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((item) => item?.id?.startsWith("gid://shopify/Product/"))
    .sort((a, b) => String(a.title || "").localeCompare(String(b.title || "")));
}

async function refreshCatalog(admin, shop) {
  try {
    const products = await fetchProductsWithBulkOperation(admin);
    await prisma.productCatalogCache.upsert({
      where: { shop },
      create: { shop, data: JSON.stringify(products), refreshedAt: new Date() },
      update: { data: JSON.stringify(products), refreshedAt: new Date() },
    });
    return products;
  } catch (bulkError) {
    console.warn(`[Product catalog] bulk export failed; using paginated fallback: ${bulkError.message}`);
    const products = await fetchProductsWithPagination(admin);
    await prisma.productCatalogCache.upsert({
      where: { shop },
      create: { shop, data: JSON.stringify(products), refreshedAt: new Date() },
      update: { data: JSON.stringify(products), refreshedAt: new Date() },
    });
    return products;
  }
}

function startBackgroundRefresh(admin, shop) {
  if (refreshesByShop.has(shop)) return;
  const refresh = refreshCatalog(admin, shop)
    .catch((error) => console.error(`[Product catalog] background refresh failed for ${shop}:`, error.message))
    .finally(() => refreshesByShop.delete(shop));
  refreshesByShop.set(shop, refresh);
}

export async function getProductCatalog(admin, shop) {
  const cached = await prisma.productCatalogCache.findUnique({ where: { shop } });
  if (cached) {
    const products = JSON.parse(cached.data);
    const ageMs = Date.now() - cached.refreshedAt.getTime();
    if (ageMs > CATALOG_TTL_MS) startBackgroundRefresh(admin, shop);
    return { products, source: ageMs > CATALOG_TTL_MS ? "stale-cache-refreshing" : "cache", refreshedAt: cached.refreshedAt };
  }

  const products = await refreshCatalog(admin, shop);
  return { products, source: "bulk", refreshedAt: new Date() };
}
