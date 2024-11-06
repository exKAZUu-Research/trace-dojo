import 'server-only';

import type { ReadonlyRequestCookies } from 'next/dist/server/web/spec-extension/adapters/request-cookies';

import type { SessionOnNode } from './sessionOnNode';
import { getSessionOnNode } from './sessionOnNode';

import { SUPERTOKENS_ACCESS_TOKEN_COOKIE_NAME } from '@/constants';

export async function getSessionOnServer(cookies: ReadonlyRequestCookies): Promise<{
  session?: SessionOnNode;
  hasToken: boolean;
  error?: Error;
}> {
  const accessToken = cookies.get(SUPERTOKENS_ACCESS_TOKEN_COOKIE_NAME)?.value;
  const hasToken = !!accessToken;
  try {
    if (accessToken) {
      return { session: await getSessionOnNode(accessToken), hasToken };
    }
  } catch (error) {
    if (error instanceof Error) {
      return { hasToken, error };
    }
  }
  return { hasToken };
}
