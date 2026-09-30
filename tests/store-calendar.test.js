/* eslint-env node */

import assert from "node:assert/strict";
import test from "node:test";

import {
  calendarDateInTimeZone,
  latestCompletedDate,
  latestSyncMonths,
  storeMonthBounds,
} from "../app/store-calendar.server.js";

test("the same instant uses each store's local calendar date", () => {
  const instant = new Date("2026-09-30T18:45:00.000Z");
  assert.equal(calendarDateInTimeZone(instant, "Asia/Kolkata"), "2026-10-01");
  assert.equal(calendarDateInTimeZone(instant, "America/Los_Angeles"), "2026-09-30");
  assert.equal(latestCompletedDate(instant, "Asia/Kolkata"), "2026-09-30");
  assert.equal(latestCompletedDate(instant, "America/Los_Angeles"), "2026-09-29");
});

test("month selection follows the store timezone around midnight", () => {
  const instant = new Date("2026-10-01T00:30:00.000Z");
  assert.equal(latestSyncMonths(instant, "Asia/Kolkata", 1)[0], "2026-09");
  assert.equal(latestSyncMonths(instant, "America/Los_Angeles", 1)[0], "2026-09");
  assert.deepEqual(storeMonthBounds("2026-09", instant, "America/Los_Angeles"), {
    start: "2026-09-01",
    end: "2026-09-29",
  });
});

test("daylight-saving transitions do not shift completed dates", () => {
  assert.equal(
    latestCompletedDate(new Date("2026-03-08T05:30:00.000Z"), "America/New_York"),
    "2026-03-07",
  );
  assert.equal(
    latestCompletedDate(new Date("2026-11-01T06:30:00.000Z"), "America/New_York"),
    "2026-10-31",
  );
});

test("invalid IANA timezones are rejected", () => {
  assert.throws(
    () => latestCompletedDate(new Date(), "Not/A_Timezone"),
    /Invalid IANA timezone/,
  );
});
