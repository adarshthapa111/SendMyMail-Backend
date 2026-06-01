import { PrismaClient } from '@prisma/client';

/* Singleton Prisma client.
   Express handlers should import this and use it directly — DO NOT instantiate
   `new PrismaClient()` per request (each instance opens a separate connection pool). */
export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

/* Graceful shutdown — release the pool when the process exits. */
const shutdown = async () => {
  await prisma.$disconnect();
};
process.on('beforeExit', shutdown);
process.on('SIGINT', () => shutdown().finally(() => process.exit(0)));
process.on('SIGTERM', () => shutdown().finally(() => process.exit(0)));
