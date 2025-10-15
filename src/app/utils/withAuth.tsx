import type { NextPage } from 'next';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import SuperTokensNode from 'supertokens-node';

import { SessionAuthForNextJs } from '@/components/molecules/SessionAuthForNextJs';
import { TryRefreshComponent } from '@/components/molecules/TryRefreshComponent';
import { AuthContextProvider } from '@/contexts/AuthContext';
import { getEmailFromSession } from '@/utils/session';
import type { SessionOnNode } from '@/utils/sessionOnNode';
import { getSessionOnServer } from '@/utils/sessionOnServer';

type MyAuthorizedNextPageOrLayoutWrapper<Params, SearchParams> = NextPage<{
  children?: React.ReactNode;
  params: Promise<Params & { locale: string }>;
  searchParams: Promise<SearchParams>;
}>;
export type MyAuthorizedNextPageOrLayout<
  Params = Record<string, never>,
  SearchParams = Record<string, never>,
> = NextPage<{
  children?: React.ReactNode;
  session: SessionOnNode;
  params: Params;
  searchParams: SearchParams;
}>;

// https://supertokens.com/docs/thirdpartyemailpassword/nextjs/app-directory/protecting-route#using---presessionauthfornextjs-and-checking-for-sessions--pre
export function withAuthorizationOnServer<Props = Record<string, never>, Params = Record<string, never>>(
  // eslint-disable-next-line @typescript-eslint/naming-convention
  PageOrLayout: MyAuthorizedNextPageOrLayout<Props, Params>,
  options?: { admin: boolean }
): MyAuthorizedNextPageOrLayoutWrapper<Props, Params> {
  return async function WithAuthorizationOnServer(props) {
    const requestCookies = await cookies();
    const { error, hasToken, session } = await getSessionOnServer(requestCookies);

    // To recover from an error, use  `redirect(await getRedirectionUrlToAuthOnServer(), RedirectType.replace)` or `RefreshSessionOnClient`.
    if (error) console.warn('Failed to get session due to %o', error);

    if (!session) {
      if (!hasToken) redirect('/auth');
      /**
       * This means that the session does not exist but we have session tokens for the user. In this case
       * the `TryRefreshComponent` will try to refresh the session.
       *
       * To learn about why the 'key' attribute is required refer to: https://github.com/supertokens/supertokens-node/issues/826#issuecomment-2092144048
       */
      return <TryRefreshComponent key={Date.now()} />;
    }

    // https://supertokens.com/docs/thirdpartyemailpassword/user-roles/protecting-routes
    if (options?.admin) {
      const userInfo = await SuperTokensNode.getUser(session.superTokensUserId);
      if (!userInfo?.emails[0].endsWith('@internet.ac.jp')) notFound();
    }

    const [params, searchParams] = await Promise.all([props.params, props.searchParams]);

    return (
      <SessionAuthForNextJs>
        <AuthContextProvider
          currentEmail={await getEmailFromSession(session.superTokensUserId)}
          currentUserId={session.superTokensUserId}
        >
          {'children' in props ? (
            <PageOrLayout params={params} searchParams={searchParams} session={session}>
              {props.children}
            </PageOrLayout>
          ) : (
            <PageOrLayout params={params} searchParams={searchParams} session={session} />
          )}
        </AuthContextProvider>
      </SessionAuthForNextJs>
    );
  };
}
