import { fetchRequestHandler } from '@trpc/server/adapters/fetch';

import { logger } from '../../../../infrastructures/pino';
import { createContext } from '../../../../infrastructures/trpcBackend/context';
import { backendRouter } from '../../../../infrastructures/trpcBackend/routers';

// cf.https://trpc.io/docs/server/adapters/nextjs#route-handlers
function handler(req: Request): Promise<Response> {
  return fetchRequestHandler({
    createContext,
    endpoint: '/api/trpc',
    onError({ error }) {
      logger.error(error);
    },
    req,
    router: backendRouter,
  });
}
export { handler as GET, handler as POST };
