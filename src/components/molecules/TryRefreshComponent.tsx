'use client';

import { useRouter } from 'next/navigation';
import type React from 'react';
import { useEffect, useState } from 'react';
import SuperTokens from 'supertokens-auth-react';
import Session from 'supertokens-auth-react/recipe/session';

export const TryRefreshComponent: React.FC<{ hasToken: boolean }> = ({ hasToken }) => {
  const router = useRouter();
  const [didError, setDidError] = useState(false);

  useEffect(() => {
    // Captured before awaiting: once a redirect to the auth page has started, the current URL is no longer the requested one.
    const redirectToPath = `${globalThis.location.pathname}${globalThis.location.search}`;
    /**
     * `attemptRefreshingSession` will call the refresh token endpoint to try and
     * refresh the session. This will throw an error if the session cannot be refreshed.
     */
    void (hasToken ? Session.attemptRefreshingSession() : Promise.resolve(false))
      .then((hasSession) => {
        /**
         * If the user has a valid session, we reload the page to restart the flow
         * with valid session tokens
         */
        if (hasSession) {
          router.refresh();
        } else {
          return SuperTokens.redirectToAuth({ redirectBack: false, queryParams: { redirectToPath } });
        }
        return;
      })
      .catch(() => {
        setDidError(true);
      });
  }, [router, hasToken]);

  /**
   * We add this check to make sure we handle the case where the refresh API fails with
   * an unexpected error
   */
  if (didError) {
    return <div>Something went wrong, please reload the page</div>;
  }

  return <div>Loading...</div>;
};
