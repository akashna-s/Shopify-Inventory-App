import prisma from "./db.server";

const FINALIZATION_GRACE_DAYS = 3;
const CACHE_VERSION = "v1";

function isFinalizedRange(rangeEnd) {
  const end = new Date(`${rangeEnd}T23:59:59`);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - FINALIZATION_GRACE_DAYS);
  return end < cutoff;
}

export async function runWithAnalyticsCache({ shop, dataset, rangeStart, rangeEnd, run }) {
  if (!isFinalizedRange(rangeEnd)) return run();

  const id = `${CACHE_VERSION}|${shop}|${dataset}|${rangeStart}|${rangeEnd}`;
  const cached = await prisma.analyticsCache.findUnique({ where: { id } });
  if (cached) return { ...JSON.parse(cached.data), cacheStatus: "hit" };

  const result = await run();
  if (!result.error && !result.truncated) {
    const cacheable = { ...result, rawJson: null };
    await prisma.analyticsCache.upsert({
      where: { id },
      create: { id, shop, dataset, rangeStart, rangeEnd, data: JSON.stringify(cacheable) },
      update: { data: JSON.stringify(cacheable), createdAt: new Date() },
    });
  }
  return { ...result, cacheStatus: "miss" };
}
