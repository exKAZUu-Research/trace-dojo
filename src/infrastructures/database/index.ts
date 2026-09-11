import { getConnectionLevelSqlitePragmas } from '@willbooster/shared-lib';
import { drizzle } from 'drizzle-orm/node-sqlite';

import { databasePath } from '../../../db/databasePath';
import { relations } from '../../../db/schema';

import { LoggedDatabaseSync } from './loggedDatabase';

const sqlite = new LoggedDatabaseSync(databasePath());
sqlite.exec(getConnectionLevelSqlitePragmas());
export const db = drizzle({ client: sqlite, relations });
