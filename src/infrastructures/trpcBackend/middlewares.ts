import { TRPCError } from '@trpc/server';

import { getSessionOnNode } from '../../utils/sessionOnNode';
import { logger } from '../pino';

import { middleware } from './trpc';

const accessTokenRegex = /(^|;)\s*sAccessToken=([^;]*)/;

// https://dev.to/franciscomendes10866/authentication-and-authorization-in-a-node-api-using-fastify-trpc-and-supertokens-3cgn
export const authorize = middleware(async ({ ctx, next }) => {
  logger.trace('Headers: %o', ctx.req.headers);

  let session;
  try {
    const match = ctx.req.headers.get('Cookie')?.match(accessTokenRegex);
    const token = match && decodeURIComponent(match[2]);
    if (token) session = await getSessionOnNode(token);
  } catch (error) {
    logger.warn(error);
  }
  if (!session) {
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  }

  return next({ ctx: { session } });
});
