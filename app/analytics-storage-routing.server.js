const DEFAULT_DATABASE_LIMIT_BYTES = 500_000_000;
const DEFAULT_SOFT_LIMIT_PERCENT = 80;
const DEFAULT_DATABASE_BASELINE_BYTES = 15_000_000;
const MIN_PROJECTED_STORE_BYTES = 8_000_000;
const PROJECTED_BYTES_PER_PRODUCT = 15_000;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function projectedStoreStorageBytes(productCount) {
  const products = Math.max(0, Math.floor(Number(productCount) || 0));
  return Math.max(
    MIN_PROJECTED_STORE_BYTES,
    products * PROJECTED_BYTES_PER_PRODUCT,
  );
}

export function analyticsDatabaseCapacityPolicy() {
  const databaseLimitBytes = positiveInteger(
    process.env.ANALYTICS_DATABASE_LIMIT_BYTES,
    DEFAULT_DATABASE_LIMIT_BYTES,
  );
  const requestedPercent = positiveInteger(
    process.env.ANALYTICS_DATABASE_SOFT_LIMIT_PERCENT,
    DEFAULT_SOFT_LIMIT_PERCENT,
  );
  const softLimitPercent = Math.min(99, requestedPercent);
  const databaseBaselineBytes = positiveInteger(
    process.env.ANALYTICS_DATABASE_BASELINE_BYTES,
    DEFAULT_DATABASE_BASELINE_BYTES,
  );

  return {
    databaseLimitBytes,
    softLimitPercent,
    softLimitBytes: Math.floor(
      (databaseLimitBytes * softLimitPercent) / 100,
    ),
    databaseBaselineBytes,
  };
}

export const analyticsStorageSizing = Object.freeze({
  minimumStoreBytes: MIN_PROJECTED_STORE_BYTES,
  bytesPerProduct: PROJECTED_BYTES_PER_PRODUCT,
});
