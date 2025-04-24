'use client';

import type { NextPage } from 'next';
import { useEffect, useState } from 'react';
import { redirectToAuth } from 'supertokens-auth-react';
import { EmailPasswordPreBuiltUI } from 'supertokens-auth-react/recipe/emailpassword/prebuiltui';
import { EmailVerificationPreBuiltUI } from 'supertokens-auth-react/recipe/emailverification/prebuiltui';
import SuperTokens from 'supertokens-auth-react/ui';

const AuthPage: NextPage = () => {
  // if the user visits a page that is not handled by us (like /auth/random), then we redirect them back to the auth page.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (SuperTokens.canHandleRoute([EmailPasswordPreBuiltUI, EmailVerificationPreBuiltUI])) {
      setLoaded(true);
    } else {
      void redirectToAuth({ redirectBack: false });
    }
  }, []);

  if (loaded) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return SuperTokens.getRoutingComponent([EmailPasswordPreBuiltUI, EmailVerificationPreBuiltUI]);
  }
};

export default AuthPage;
