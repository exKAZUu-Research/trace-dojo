import { defineConfig } from 'drizzle-kit';

import { databasePath } from './db/databasePath';

export default defineConfig({
  dialect: 'sqlite',
  schema: './db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: databasePath() },
});
