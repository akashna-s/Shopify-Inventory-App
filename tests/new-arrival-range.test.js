/* eslint-env node */

import assert from "node:assert/strict";
import test from "node:test";

import { normalizeNewArrivalRange } from "../app/new-arrival-range.js";

test("default New Arrival range is ready before the route loader completes", () => {
  const range = normalizeNewArrivalRange(
    "/app/new-arrivals",
    new Date(2026, 9, 8, 12),
  );
  assert.equal(range.start, "2025-08-01");
  assert.equal(range.end, "2026-10-07");
  assert.equal(range.earliest, "2025-05-01");
});

test("pending New Arrival range respects destination query parameters", () => {
  const range = normalizeNewArrivalRange(
    "/app/new-arrivals?start=2026-04-01&end=2026-09-30&classification=tag",
    new Date(2026, 9, 8, 12),
  );
  assert.equal(range.start, "2026-04-01");
  assert.equal(range.end, "2026-09-30");
  assert.equal(range.classification, "tag");
});
