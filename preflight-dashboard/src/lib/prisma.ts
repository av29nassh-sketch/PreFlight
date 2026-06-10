import { PrismaClient } from "@prisma/client";

const prismaClientSingleton = () =>
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"]
  });

declare global {
  // eslint-disable-next-line no-var
  var __preflightPrisma: ReturnType<typeof prismaClientSingleton> | undefined;
}

export const prisma = globalThis.__preflightPrisma ?? prismaClientSingleton();

if (process.env.NODE_ENV !== "production") {
  globalThis.__preflightPrisma = prisma;
}
