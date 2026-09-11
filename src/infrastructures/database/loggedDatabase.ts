import { DatabaseSync, type StatementSync } from 'node:sqlite';

import { logger } from '../pino';

export class LoggedDatabaseSync extends DatabaseSync {
  override prepare(...args: Parameters<DatabaseSync['prepare']>): StatementSync {
    const statement = super.prepare(...args);
    statement.all = logQueryDuration(args[0], statement.all.bind(statement));
    statement.get = logQueryDuration(args[0], statement.get.bind(statement));
    statement.run = logQueryDuration(args[0], statement.run.bind(statement));
    return statement;
  }
}

function logQueryDuration<T extends (...args: never[]) => unknown>(query: string, execute: T): T {
  return new Proxy(execute, {
    apply(target, receiver, args) {
      const startedAt = performance.now();
      try {
        return Reflect.apply(target, receiver, args);
      } finally {
        const duration = performance.now() - startedAt;
        if (duration >= 200) logger.error('%s (duration: %d ms)', query, duration);
        else if (duration >= 100) logger.warn('%s (duration: %d ms)', query, duration);
      }
    },
  });
}
