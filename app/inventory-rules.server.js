function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Reporting inventory never allows a negative product balance to reduce a
 * store or New Arrival total. Product-month facts remain raw for audit use.
 */
function nonNegativeInventory(value) {
  return Math.max(0, finiteNumber(value));
}

function sumNonNegativeInventory(rows, field) {
  return rows.reduce(
    (total, row) => total + nonNegativeInventory(row?.[field]),
    0,
  );
}

export { nonNegativeInventory, sumNonNegativeInventory };
