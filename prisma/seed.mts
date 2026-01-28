import { getConnectionLevelSqlitePragmas, getPersistentSqlitePragmas } from '@willbooster/shared-lib';

import { prisma } from './prisma.mjs';

async function main(): Promise<void> {
  // Initialize persistent PRAGMA (journal_mode) and connection-level SQLite PRAGMAs.
  await prisma.$queryRawUnsafe(`${getPersistentSqlitePragmas()} ${getConnectionLevelSqlitePragmas()}`);
}

// eslint-disable-next-line unicorn/prefer-top-level-await
void (async () => {
  try {
    await main();
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
})();
