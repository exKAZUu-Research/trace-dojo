import { PrismaClient } from '@prisma/client';
import { getConnectionLevelSqlitePragmas } from '@willbooster/shared-lib';

import { logger } from '../pino';

export const prisma = createPrismaClient();

function createPrismaClient(): PrismaClient {
  // cf. https://www.prisma.io/docs/orm/overview/databases/sqlite#using-the-better-sqlite3-driver
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set');
  }
  const prisma = new PrismaClient({
    log: [
      {
        emit: 'event',
        level: 'query',
      },
    ],
  });
  // https://github.com/prisma/prisma/issues/5026#issuecomment-759596097
  const isDebug = process.env.WB_ENV === 'development' && process.env.PRISMA_DEBUG;
  if (isDebug) {
    prisma.$on('query', (e) => {
      let index = 0;
      const params = JSON.parse(e.params) as unknown[];
      const query = e.query.replaceAll('?', () => JSON.stringify(params[index++] ?? '?'));
      const funcName = e.duration >= 200 ? 'error' : e.duration >= 100 ? 'warn' : 'debug';
      logger[funcName]('%s (duration: %d ms)', query, e.duration);
    });
  } else {
    prisma.$on('query', (e) => {
      if (e.duration < 100) return;
      const funcName = e.duration >= 200 ? 'error' : 'warn';
      logger[funcName]('%s (duration: %d ms)', e.query, e.duration);
    });
  }
  prisma.$queryRawUnsafe(getConnectionLevelSqlitePragmas()).catch((error: unknown) => {
    logger.error('Failed to initialize connection-level PRAGMAs: %s', error);
  });
  return prisma;
}
