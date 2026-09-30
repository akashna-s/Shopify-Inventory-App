// Shopify owns these identifiers. Keep them as decimal text so JavaScript
// never rounds a future unsigned 64-bit ID. Internal database IDs stay numeric.
export function shopifyIdText(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new Error("Shopify ID arrived as an unsafe JavaScript number. Use its string or GraphQL ID value.");
  }
  const match = String(value).trim().match(/(\d+)$/);
  return match?.[1] || "";
}
