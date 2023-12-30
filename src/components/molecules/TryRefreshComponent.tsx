'use client';

import { useRouter } from 'next/navigation';
import React, { useEffect, useState } from 'react';
import SuperTokens from 'supertokens-auth-react';
import Session from 'supertokens-auth-react/recipe/session';

export const TryRefreshComponent: React.FC = () => {
  const router = useRouter();
  const [didError, setDidError] = useState(false);

  useEffect(() => {
    /**
     * `attemptRefreshingSession` will call the refresh token endpoint to try and
     * refresh the session. This will throw an error if the session cannot be refreshed.
     */
    void Session.attemptRefreshingSession()
      .then((hasSession) => {
        /**
         * If the user has a valid session, we reload the page to restart the flow
         * with valid session tokens
         */
        if (hasSession) {
          router.refresh();
        } else {
          SuperTokens.redirectToAuth();
        }
      })
      .catch(() => {
        setDidError(true);
      });
  }, [router]);

  /**
   * We add this check to make sure we handle the case where the refresh API fails with
   * an unexpected error
   */
  if (didError) {
    return <div>Something went wrong, please reload the page</div>;
  }

  return <div>Loading...</div>;
};
