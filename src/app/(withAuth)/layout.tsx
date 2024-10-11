import type { NextPage } from 'next';
import { redirect } from 'next/navigation';
import React, { Suspense } from 'react';

import { SessionAuthForNextJs } from '../../components/molecules/SessionAuthForNextJs';
import { TryRefreshComponent } from '../../components/molecules/TryRefreshComponent';
import { DefaultFooter } from '../../components/organisms/DefaultFooter';
import { DefaultHeader } from '../../components/organisms/DefaultHeader';
import { AuthContextProvider } from '../../contexts/AuthContext';
import { Container, Spinner } from '../../infrastructures/useClient/chakra';
import type { LayoutProps } from '../../types';
import { getEmailFromSession, getNullableSessionOnServer } from '../../utils/session';

const DefaultLayout: NextPage<LayoutProps> = async ({ children }) => {
  const { hasToken, session } = await getNullableSessionOnServer();

  // `session` will be undefined if it does not exist or has expired
  if (!session) {
    if (!hasToken) {
      /**
       * This means that the user is not logged in. If you want to display some other UI in this
       * case, you can do so here.
       */
      redirect('/auth');
    }

    /**
     * This means that the session does not exist but we have session tokens for the user. In this case
     * the `TryRefreshComponent` will try to refresh the session.
     *
     * To learn about why the 'key' attribute is required refer to: https://github.com/supertokens/supertokens-node/issues/826#issuecomment-2092144048
     */
    return <TryRefreshComponent key={Date.now()} />;
  }

  /**
   * SessionAuthForNextJS will handle proper redirection for the user based on the different session states.
   * It will redirect to the login page if the session does not exist etc.
   */
  return (
    <>
      <SessionAuthForNextJs />

      <DefaultHeader />
      <Suspense fallback={<Spinner left="50%" position="fixed" top="50%" transform="translate(-50%, -50%)" />}>
        <Container pb={16} pt={6}>
          <AuthContextProvider
            currentEmail={await getEmailFromSession(session.superTokensUserId)}
            currentUserId={session.superTokensUserId}
          >
            {children}
          </AuthContextProvider>
        </Container>
      </Suspense>
      <DefaultFooter />
    </>
  );
};

export default DefaultLayout;
