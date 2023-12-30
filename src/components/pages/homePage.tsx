import type { NextPage } from 'next';
import { redirect } from 'next/navigation';

import { getSSRSession } from '../../app/sessionUtils';
import { SessionAuthForNext } from '../molecules/SessionAuthForNext';
import { TryRefreshComponent } from '../molecules/TryRefreshComponent';

export const HomePage: NextPage = async () => {
  const { hasInvalidClaims, hasToken, session } = await getSSRSession();

  // `session` will be undefined if it does not exist or has expired
  if (!session) {
    if (!hasToken) {
      /**
       * This means that the user is not logged in.
       * If you want to display some other UI in this case, you can do so here.
       */
      return redirect('/auth');
    }

    /**
     * `hasInvalidClaims` indicates that session claims did not pass validation.
     * For example if email verification is required but the user's email has not been verified.
     */
    return hasInvalidClaims ? (
      /**
       * This will make sure that the user is redirected based on their session claims.
       * For example, they will be redirected to the email verification screen if needed.
       *
       * We pass in no children in this case to prevent hydration issues and still be able to redirect the
       * user.
       */
      <SessionAuthForNext />
    ) : (
      /**
       * This means that the session does not exist, but we have session tokens for the user.
       * In this case the `TryRefreshComponent` will try to refresh the session.
       */
      <TryRefreshComponent />
    );
  }

  /**
   * SessionAuthForNextJS will handle proper redirection for the user based on the different session states.
   * It will redirect to the login page if the session does not exist etc.
   */
  return (
    <SessionAuthForNext>
      <div>Your user id is: {session.getUserId()}</div>
    </SessionAuthForNext>
  );
};
