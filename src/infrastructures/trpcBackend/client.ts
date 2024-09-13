'use client';

import { createTRPCReact, httpBatchLink } from '@trpc/react-query';
import superjson from 'superjson';

import type { BackendRouter } from './routers';

// https://trpc.io/docs/client/react/setup
export const backendTrpcReact = createTRPCReact<BackendRouter>();

export const backendTrpcReactClient = backendTrpcReact.createClient({
  links: [httpBatchLink({ url: '/api/trpc', transformer: superjson })],
});
