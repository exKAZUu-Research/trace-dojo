import { serialize } from 'cookie';
import { cookies, headers } from 'next/headers';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { PreParsedRequest, CollectingResponse } from 'supertokens-node/framework/custom';
import type { SessionContainer, VerifySessionOptions } from 'supertokens-node/recipe/session';
import Session from 'supertokens-node/recipe/session';
import type { HTTPMethod } from 'supertokens-node/types';

import { ensureSuperTokensInit } from '../infrastructures/supertokens/backendConfig';

ensureSuperTokensInit();

interface SSRSession {
  session: SessionContainer | undefined;
  hasToken: boolean;
  /**
   * This allows us to protect our routes based on the current session claims. For example
   * this will be true if email verification is required but the user has not verified their
   * email.
   */
  hasInvalidClaims: boolean;
  baseResponse: CollectingResponse;
  nextResponse?: NextResponse;
}

export async function getSSRSession(req?: NextRequest, options?: VerifySessionOptions): Promise<SSRSession> {
  const query = req === undefined ? {} : Object.fromEntries(new URL(req.url).searchParams.entries());
  const parsedCookies: Record<string, string> = Object.fromEntries(
    (req === undefined ? cookies() : req.cookies).getAll().map((cookie) => [cookie.name, cookie.value])
  );

  /**
   * Pre parsed request is a wrapper exposed by SuperTokens. It is used as a helper to detect if the
   * original request contains session tokens. We then use this pre parsed request to call `getSession`
   * to check if there is a valid session.
   */
  const baseRequest = new PreParsedRequest({
    method: req === undefined ? 'get' : (req.method as HTTPMethod),
    url: req === undefined ? '' : req.url,
    query,
    headers: req === undefined ? headers() : req.headers,
    cookies: parsedCookies,
    getFormBody: () => req!.formData(),
    getJSONBody: () => req!.json(),
  });

  /**
   * Collecting response is a wrapper exposed by SuperTokens. In this case we are using an empty
   * CollectingResponse when calling `getSession`. If the request contains valid session tokens
   * the SuperTokens SDK will attach all the relevant tokens to the collecting response object which
   * we can then use to return those session tokens in the final result (refer to `withSession` in this file)
   */
  const baseResponse = new CollectingResponse();

  try {
    /**
     * `getSession` will throw if session is required and there is no valid session. You can use
     * `options` to configure whether or not you want to require sessions when calling `getSSRSession`
     */
    const session = await Session.getSession(baseRequest, baseResponse, options);
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

export async function withSession(
  request: NextRequest,
  handler: (session: SessionContainer | undefined) => Promise<NextResponse>,
  options?: VerifySessionOptions
): Promise<NextResponse<unknown>> {
  const { baseResponse, nextResponse, session } = await getSSRSession(request, options);
  if (nextResponse) {
    return nextResponse;
  }

  const userResponse = await handler(session);

  let didAddCookies = false;
  let didAddHeaders = false;

  /**
   * Base response is the response from SuperTokens that contains all the session tokens.
   * We add all cookies and headers in the base response to the final response from the
   * API to make sure sessions work correctly.
   */
  for (const respCookie of baseResponse.cookies) {
    didAddCookies = true;
    userResponse.headers.append(
      'Set-Cookie',
      serialize(respCookie.key, respCookie.value, {
        domain: respCookie.domain,
        expires: new Date(respCookie.expires),
        httpOnly: respCookie.httpOnly,
        path: respCookie.path,
        sameSite: respCookie.sameSite,
        secure: respCookie.secure,
      })
    );
  }

  for (const [value, key] of baseResponse.headers) {
    didAddHeaders = true;
    userResponse.headers.set(key, value);
  }

  /**
   * For some deployment services (Vercel for example) production builds can return cached results for
   * APIs with older header values. In this case if the session tokens have changed (because of refreshing
   * for example) the cached result would still contain the older tokens and sessions would stop working.
   *
   * As a result, if we add cookies or headers from base response we also set the Cache-Control header
   * to make sure that the final result is not a cached version.
   */
  if ((didAddCookies || didAddHeaders) && !userResponse.headers.has('Cache-Control')) {
    // This is needed for production deployments with Vercel
    userResponse.headers.set('Cache-Control', 'no-cache, no-store, max-age=0, must-revalidate');
  }

  return userResponse;
}
