/* eslint-env node */

import assert from "node:assert/strict";
import test from "node:test";

import {
  loadNewArrivalMonthlySource,
  newArrivalLookbackBounds,
  newArrivalSourceFromMonthlyReport,
} from "../app/new-arrival-monthly-source.server.js";

test("saved New Arrival source keeps the two-month cohort lookback out of visible rows", () => {
  const source = newArrivalSourceFromMonthlyReport(
    {
      rows: [
        {
          day: "2026-01-01",
          productId: "101",
          startingInventory: 2,
          endingInventory: 1,
          totalSales: 0,
        },
        {
          day: "2026-03-01",
          productId: "101",
          title: "Existing product",
          productType: "Dress",
          tags: ["Best Sellers"],
          handle: "existing-product",
          imageUrl: "https://cdn.example/product.jpg",
          productUrl: "https://shop.example/products/existing-product",
          startingInventory: 1,
          endingInventory: 0,
          totalSales: 50,
          orders: 1,
          landingSessions: 10,
        },
        {
          day: "2026-03-01",
          productId: "UNATTRIBUTED",
          isUnattributed: true,
          totalSales: 5,
        },
      ],
      monthlyStoreSales: {
        "2026-01": 0,
        "2026-03": 55,
      },
      shopCurrency: "INR",
      dataSource: "supabase-database-monthly",
      catalogRefreshedAt: "2026-03-31T05:00:00.000Z",
    },
    {
      start: "2026-03-01",
      end: "2026-03-31",
      lookbackStart: "2026-01-01",
    },
  );

  assert.deepEqual([...source.firstCohortProductIds], ["101"]);
  assert.equal(source.sourceRows.length, 2);
  assert.equal(source.sourceRows[0].period, "2026-03");
  assert.equal(source.sourceRows[0].productTags[0], "Best Sellers");
  assert.equal(source.sourceRows[1].isUnattributed, true);
  assert.deepEqual(source.monthlyStoreSales, { "2026-03": 55 });
});

test("saved New Arrival lookback starts two calendar months before the selected range", () => {
  assert.deepEqual(newArrivalLookbackBounds("2026-03-01"), {
    start: "2026-01-01",
    end: "2026-02-28",
  });
});

test("partial first months stay on the existing live ShopifyQL path", async () => {
  const source = await loadNewArrivalMonthlySource({
    session: null,
    start: "2026-03-12",
    end: "2026-03-31",
    shopInfo: { currency: "INR", shopUrl: "https://shop.example" },
  });
  assert.equal(source, null);
});

