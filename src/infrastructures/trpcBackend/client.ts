'use client';

import { httpBatchLink } from '@trpc/client';
import { createTRPCReact } from '@trpc/react-query';
import type { CreateTRPCReact } from '@trpc/react-query';

import superjson from 'superjson';
import type { BackendRouter } from './routers';

export const backendTrpcReact: CreateTRPCReact<BackendRouter, unknown> = createTRPCReact<BackendRouter>();

export const backendTrpcReactClient = backendTrpcReact.createClient({
  links: [httpBatchLink({ url: '/api/trpc', transformer: superjson })],
});
