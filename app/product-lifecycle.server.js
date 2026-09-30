const CATALOG_STATES = new Set(["present", "missing", "deleted"]);

function effectiveProductStatus(product) {
  if (String(product?.record_kind || "").toLowerCase() === "unattributed")
    return "UNATTRIBUTED";
  const catalogState = String(product?.catalog_state || "present").toLowerCase();
  if (catalogState === "deleted") return "DELETED";
  if (catalogState === "missing") return "MISSING";
  return String(product?.status || "").toUpperCase() || "UNKNOWN";
}

function isValidCatalogState(value) {
  return CATALOG_STATES.has(String(value || "").toLowerCase());
}

export { effectiveProductStatus, isValidCatalogState };
