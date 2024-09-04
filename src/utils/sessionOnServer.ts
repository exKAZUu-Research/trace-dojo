import { cookies } from 'next/headers.js';

import { SUPERTOKENS_ACCESS_TOKEN_COOKIE_NAME } from './constants';
import type { SessionOnNode } from './sessionOnNode';
import { getSessionOnNode } from './sessionOnNode';

export async function getSessionOnServer(): Promise<{
  session?: SessionOnNode;
  hasToken: boolean;
  error?: Error;
}> {
  const accessToken = getAccessToken();
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

function getAccessToken(): string | undefined {
  return cookies().get(SUPERTOKENS_ACCESS_TOKEN_COOKIE_NAME)?.value;
}
