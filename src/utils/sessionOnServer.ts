import 'server-only';

import type { ReadonlyRequestCookies } from 'next/dist/server/web/spec-extension/adapters/request-cookies';

import { SUPERTOKENS_ACCESS_TOKEN_COOKIE_NAME } from '@/constants';

import type { SessionOnNode } from './sessionOnNode';
import { getSessionOnNode } from './sessionOnNode';

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
