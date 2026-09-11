import { DatabaseSync } from 'node:sqlite';

import { getConnectionLevelSqlitePragmas, getPersistentSqlitePragmas } from '@willbooster/shared-lib';

import { databasePath } from './databasePath.ts';

const sqlite = new DatabaseSync(databasePath());
try {
  sqlite.exec(`${getPersistentSqlitePragmas()} ${getConnectionLevelSqlitePragmas()}`);
} finally {
  sqlite.close();
}
