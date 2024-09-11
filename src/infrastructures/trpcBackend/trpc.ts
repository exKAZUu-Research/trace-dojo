// cf. https://trpc.io/docs/client/nextjs/setup#3-create-a-trpc-router
import { initTRPC } from '@trpc/server';

import type { Context } from './context';

const t = initTRPC.context<Context>().create();

export const middleware = t.middleware;
export const router = t.router;
export const procedure = t.procedure;
