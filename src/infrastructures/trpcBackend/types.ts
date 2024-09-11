import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';

import type { BackendRouter } from './routers';

export type BackendRouterInputs = inferRouterInputs<BackendRouter>;
export type BackendRouterOutputs = inferRouterOutputs<BackendRouter>;
