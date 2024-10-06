import type { NextPage } from 'next';
import { notFound } from 'next/navigation';
import SuperTokensNode from 'supertokens-node';

import type { LayoutProps } from '../../../types';
import { getNullableSessionOnServer } from '../../../utils/session';

const DefaultLayout: NextPage<LayoutProps> = async ({ children }) => {
  const { session } = await getNullableSessionOnServer();
  if (!session) notFound();

  const userInfo = await SuperTokensNode.getUser(session.superTokensUserId);
  if (!userInfo?.emails[0].endsWith('@internet.ac.jp')) notFound();

  return children;
};

export default DefaultLayout;
