import { cookies, headers } from 'next/headers';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { CollectingResponse, PreParsedRequest } from 'supertokens-node/framework/custom';
import type { SessionContainer, VerifySessionOptions } from 'supertokens-node/recipe/session';
import Session from 'supertokens-node/recipe/session';
import type { HTTPMethod } from 'supertokens-node/types';

import { logger } from './pino';
import { prisma } from './prisma';
import { ensureSuperTokensInit } from './supertokens/backendConfig';

ensureSuperTokensInit();

export interface SessionOnServerLayout {
  session: SessionContainer | undefined;
  hasToken: boolean;
  /**
   * This allows us to protect our routes based on the current session claims.
   * For example this will be true if email verification is required but the user has not verified their email.
   */
  hasInvalidClaims: boolean;
  baseResponse: CollectingResponse;
  nextResponse?: NextResponse;
}

export async function getSessionOnServerLayout(
  req?: NextRequest,
  options?: VerifySessionOptions
): Promise<SessionOnServerLayout> {
  const baseRequest = getBaseRequest(req);

  // Collecting response is a wrapper exposed by SuperTokens. In this case we are using an empty
  // CollectingResponse when calling `getSession`. If the request contains valid session tokens
  // the SuperTokens SDK will attach all the relevant tokens to the collecting response object which
  // we can then use to return those session tokens in the final result (refer to `withSession` in this file)
  const baseResponse = new CollectingResponse();

  try {
    // `getSession` will throw if session is required and there is no valid session. You can use
    // `options` to configure whether or not you want to require sessions when calling `getSSRSession`
    const session = await Session.getSession(baseRequest, baseResponse, options);

    // Update User table with Prisma
    if (session) {
      await upsertUserToPrisma(session.getUserId());
    }

    return {
      session,
      hasInvalidClaims: false,
      hasToken: session !== undefined,
      baseResponse,
    };
  } catch (error) {
    if (Session.Error.isErrorFromSuperTokens(error)) {
      return {
        hasToken: error.type !== Session.Error.UNAUTHORISED,
        hasInvalidClaims: error.type === Session.Error.INVALID_CLAIMS,
        session: undefined,
        baseResponse,
        nextResponse: new NextResponse('Authentication required', {
          status: error.type === Session.Error.INVALID_CLAIMS ? 403 : 401,
        }),
      };
    } else {
      throw error;
    }
  }
}

export async function getSessionOnServerPage(
  req?: NextRequest,
  options?: VerifySessionOptions
): Promise<SessionContainer> {
  const baseRequest = getBaseRequest(req);
  const baseResponse = new CollectingResponse();
  const session = await Session.getSession(baseRequest, baseResponse, options);
  if (!session) {
    throw new Error('Failed to get a session.');
  }
  return session;
}

function getBaseRequest(req: NextRequest | undefined): PreParsedRequest {
  const query = req === undefined ? {} : Object.fromEntries(new URL(req.url).searchParams.entries());
  const parsedCookies: Record<string, string> = Object.fromEntries(
    (req === undefined ? cookies() : req.cookies).getAll().map((cookie) => [cookie.name, cookie.value])
  );

  // Pre parsed request is a wrapper exposed by SuperTokens. It is used as a helper to detect if the
  // original request contains session tokens. We then use this pre parsed request to call `getSession`
  // to check if there is a valid session.
  return new PreParsedRequest({
    method: req === undefined ? 'get' : (req.method as HTTPMethod),
    url: req === undefined ? '' : req.url,
    query,
    headers: req === undefined ? headers() : req.headers,
    cookies: parsedCookies,
    getFormBody: () => req!.formData(),
    getJSONBody: () => req!.json(),
  });
}

const upsertedUserIds = new Set<string>();

async function upsertUserToPrisma(superTokensUserId: string): Promise<void> {
  if (upsertedUserIds.has(superTokensUserId)) return;

  upsertedUserIds.add(superTokensUserId);
  const user = await prisma.user.upsert({
    create: { superTokensUserId },
    update: {},
    where: { superTokensUserId },
  });
  logger.debug('User upserted: %o', user);
}
