CREATE TABLE "ProductCatalogCache" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "data" TEXT NOT NULL,
    "refreshedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "AnalyticsCache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "dataset" TEXT NOT NULL,
    "rangeStart" TEXT NOT NULL,
    "rangeEnd" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "AnalyticsCache_shop_dataset_rangeStart_rangeEnd_idx"
ON "AnalyticsCache"("shop", "dataset", "rangeStart", "rangeEnd");
