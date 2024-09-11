import { z } from 'zod';

import { authorize } from '../middlewares';
import { procedure, router } from '../trpc';

export const backendRouter = router({
  getSession: procedure
    .use(authorize)
    .output(z.object({ userId: z.string().uuid() }))
    .query(({ ctx }) => ({ userId: ctx.session.superTokensUserId })),
});

// export type definition of API
export type BackendRouter = typeof backendRouter;
