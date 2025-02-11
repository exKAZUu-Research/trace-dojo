'use client';

import { httpBatchLink } from '@trpc/client';
import { createTRPCReact } from '@trpc/react-query';
import superjson from 'superjson';

import type { BackendRouter } from './routers';

// https://trpc.io/docs/client/react/setup
export const backendTrpcReact = createTRPCReact<BackendRouter>();

export const backendTrpcReactClient = backendTrpcReact.createClient({
  // Date型を扱えるようにするため、 superjson を導入する。
  links: [httpBatchLink({ url: '/api/trpc', transformer: superjson })],
});
