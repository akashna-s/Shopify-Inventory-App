const number = (value) => Number(value) || 0;

export function handleFromLandingPath(path) {
  const match = String(path || "").match(/\/products\/([^/?#]+)/i);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]).trim().toLowerCase();
  } catch {
    return match[1].trim().toLowerCase();
  }
}

export function matchLandingSessions(rows, handleHistory) {
  const byHandle = new Map();
  for (const history of handleHistory) {
    const handle = String(history.handle || "").trim().toLowerCase();
    if (!handle) continue;
    const productId = String(history.shopify_product_id);
    const existing = byHandle.get(handle);
    byHandle.set(handle, existing && existing !== productId ? null : productId);
  }

  const matched = new Map();
  const unmatched = new Map();
  for (const row of rows || []) {
    const handle = handleFromLandingPath(row.landing_page_path);
    const count = number(row.sessions);
    const productId = byHandle.get(handle);
    if (productId) {
      matched.set(productId, (matched.get(productId) || 0) + count);
    } else if (handle) {
      unmatched.set(handle, (unmatched.get(handle) || 0) + count);
    }
  }
  return { matched, unmatched };
}
