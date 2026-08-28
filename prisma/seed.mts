import { getConnectionLevelSqlitePragmas, getPersistentSqlitePragmas } from '@willbooster/shared-lib';

import { prisma } from './prisma.mts';

async function main(): Promise<void> {
  // Initialize persistent PRAGMA (journal_mode) and connection-level SQLite PRAGMAs.
  await prisma.$queryRawUnsafe(`${getPersistentSqlitePragmas()} ${getConnectionLevelSqlitePragmas()}`);
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
