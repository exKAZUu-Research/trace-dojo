'use client';

import type { NextPage } from 'next';
import { useEffect, useState } from 'react';
import { redirectToAuth } from 'supertokens-auth-react';
import { EmailPasswordPreBuiltUI } from 'supertokens-auth-react/recipe/emailpassword/prebuiltui';
import SuperTokens from 'supertokens-auth-react/ui';

import { clearAllCaches } from '../../../asyncFunctions/cache/actions';

const AuthPage: NextPage = () => {
  // if the user visits a page that is not handled by us (like /auth/random), then we redirect them back to the auth page.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    // サインイン/アップに伴う画面表示の変更を反映するために、全ページのキャッシュを削除する。
    void clearAllCaches();

    if (SuperTokens.canHandleRoute([EmailPasswordPreBuiltUI])) {
      setLoaded(true);
    } else {
      void redirectToAuth({ redirectBack: false });
    }
  }, []);

  if (loaded) {
    return SuperTokens.getRoutingComponent([EmailPasswordPreBuiltUI]);
  }
};

export default AuthPage;
