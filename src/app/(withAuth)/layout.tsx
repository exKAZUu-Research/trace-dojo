import { Container, Spinner } from '@chakra-ui/react';
import type { NextPage } from 'next';
import { redirect } from 'next/navigation';
import React, { Suspense } from 'react';

import { SessionAuthForNext } from '../../components/molecules/SessionAuthForNext';
import { TryRefreshComponent } from '../../components/molecules/TryRefreshComponent';
import { DefaultFooter } from '../../components/organisms/DefaultFooter';
import { DefaultHeader } from '../../components/organisms/DefaultHeader';
import type { LayoutProps } from '../../types';
import { getSSRSession } from '../sessionUtils';

const DefaultLayout: NextPage<LayoutProps> = async ({ children }) => {
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
   * SessionAuthForNext will handle proper redirection for the user based on the different session states.
   * It will redirect to the login page if the session does not exist etc.
   */
  return (
    <>
      <SessionAuthForNext />

      <DefaultHeader />

      <Suspense fallback={<Spinner left="50%" position="fixed" top="50%" transform="translate(-50%, -50%)" />}>
        <Container pb={16} pt={8}>
          {children}
        </Container>
      </Suspense>

      <DefaultFooter />
    </>
  );
};

export default DefaultLayout;
