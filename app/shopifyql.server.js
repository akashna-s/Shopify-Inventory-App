const ROW_LIMIT = 100000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 900;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const retryable = (message = "") => /rate limit|throttl|temporar|timeout|timed out|service unavailable|internal server|502|503|504/i.test(message);

export async function runShopifyQL(admin, query, { limit = ROW_LIMIT } = {}) {
  const limitedQuery = /\bLIMIT\b/i.test(query) ? query : `${query} LIMIT ${limit}`;
  const startedAt = Date.now();
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await admin.graphql(
        `#graphql
        query NewArrivalShopifyQL($query: String!) {
          shopifyqlQuery(query: $query) {
            tableData { columns { name } rows }
            parseErrors
          }
        }`,
        { variables: { query: limitedQuery } },
      );
      const json = await response.json();
      const message = json.errors?.[0]?.message || "";
      if (message && retryable(message) && attempt < MAX_ATTEMPTS) {
        await wait(RETRY_BASE_MS * (2 ** (attempt - 1)));
        continue;
      }
      if (message) return { rows: [], error: message, truncated: false, attempts: attempt, elapsedMs: Date.now() - startedAt };
      const result = json.data?.shopifyqlQuery;
      if (result?.parseErrors?.length) return { rows: [], error: result.parseErrors.join("; "), truncated: false, attempts: attempt, elapsedMs: Date.now() - startedAt };
      const columns = result?.tableData?.columns || [];
      const rows = (result?.tableData?.rows || []).map((row) => Array.isArray(row)
        ? Object.fromEntries(columns.map((column, index) => [column.name, row[index]]))
        : row);
      return { rows, error: null, truncated: rows.length >= limit, attempts: attempt, elapsedMs: Date.now() - startedAt };
    } catch (error) {
      const message = error?.message || "ShopifyQL request failed.";
      if (retryable(message) && attempt < MAX_ATTEMPTS) {
        await wait(RETRY_BASE_MS * (2 ** (attempt - 1)));
        continue;
      }
      return { rows: [], error: message, truncated: false, attempts: attempt, elapsedMs: Date.now() - startedAt };
    }
  }
  return { rows: [], error: "ShopifyQL failed after retries.", truncated: false, attempts: MAX_ATTEMPTS, elapsedMs: Date.now() - startedAt };
}
