import type { NextRequest } from 'next/server';
import { getAppDirRequestHandler } from 'supertokens-node/nextjs';

import { ensureSuperTokensInit } from '../../../../infrastructures/supertokens/backendConfig';

ensureSuperTokensInit();

const handleCall = getAppDirRequestHandler();

// cf. https://supertokens.com/docs/emailpassword/nextjs/app-directory/setting-up-backend
export async function GET(request: NextRequest): Promise<Response> {
  const res = await handleCall(request);
  if (!res.headers.has('Cache-Control')) {
    // This is needed for production deployments with Vercel
    res.headers.set('Cache-Control', 'no-cache, no-store, max-age=0, must-revalidate');
  }
  return res;
}

export async function POST(request: NextRequest): Promise<Response> {
  return handleCall(request);
}

export async function DELETE(request: NextRequest): Promise<Response> {
  return handleCall(request);
}

export async function PUT(request: NextRequest): Promise<Response> {
  return handleCall(request);
}

export async function PATCH(request: NextRequest): Promise<Response> {
  return handleCall(request);
}

export async function HEAD(request: NextRequest): Promise<Response> {
  return handleCall(request);
}
