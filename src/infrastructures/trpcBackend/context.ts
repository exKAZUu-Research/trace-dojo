import type { inferRouterContext } from '@trpc/server';
import type { FetchCreateContextFnOptions } from '@trpc/server/adapters/fetch';

import { logger } from '../pino';

import type { BackendRouter } from './routers';

export type Context = FetchCreateContextFnOptions;

// cf. https://trpc.io/docs/server/adapters/fastify#create-the-context
export function createContext(options: FetchCreateContextFnOptions): inferRouterContext<BackendRouter> {
  logger.debug(`%s %s` + (options.req.body ? `\n%o` : ''), options.req.method, options.req.url, options.req.body);

  return options;
}
