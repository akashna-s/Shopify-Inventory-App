import { PrismaClient } from "@prisma/client";

if (process.env.NODE_ENV !== "production") {
  // During development Prisma is kept globally so every hot reload does not
  // open another database connection. After adding a new Prisma model, however,
  // that existing instance can still have the old generated shape. Replace it
  // when either audit-cache delegate is missing.
  const prismaIsStale = global.prismaGlobal && (
    !global.prismaGlobal.productCatalogCache ||
    !global.prismaGlobal.analyticsCache
  );

  if (prismaIsStale) {
    global.prismaGlobal.$disconnect().catch(() => {});
    global.prismaGlobal = null;
  }

  if (!global.prismaGlobal) {
    global.prismaGlobal = new PrismaClient();
  }
}

const prisma = global.prismaGlobal ?? new PrismaClient();

export default prisma;
