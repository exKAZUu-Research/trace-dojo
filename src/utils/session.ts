import { memoizeFactory } from 'at-decorators';
import SuperTokensNode from 'supertokens-node';

import { logger } from '../infrastructures/pino';
import { prisma } from '../infrastructures/prisma';

import type { SessionOnNode } from './sessionOnNode';
import { getSessionOnServer } from './sessionOnServer';

export interface SessionOnServer {
  session: SessionOnNode | undefined;
  hasToken: boolean;
  error: unknown | undefined;
}

export async function getNullableSessionOnServer(): Promise<SessionOnServer> {
  let session: SessionOnNode | undefined;
  let hasToken = false;
  let error: unknown | undefined = undefined;

  try {
    ({ hasToken, session } = await getSessionOnServer());
    if (session) {
      void upsertUserToPrisma(session.superTokensUserId);
    }
  } catch (error_: unknown) {
    error = error_;
  }
  return { session, hasToken, error };
}

export async function getNonNullableSessionOnServer(): Promise<SessionOnNode> {
  const { session } = await getSessionOnServer();
  if (!session) {
    throw new Error('Failed to get a session.');
  }
  void upsertUserToPrisma(session.superTokensUserId);
  return session;
}

const upsertedUserIds = new Set<string>();

async function upsertUserToPrisma(id: string): Promise<void> {
  if (upsertedUserIds.has(id)) return;

  upsertedUserIds.add(id);
  const user = await prisma.user.upsert({
    create: { id, displayName: id },
    update: {},
    where: { id },
  });
  logger.debug('User upserted: %o', user);
}

const memoizeForEmails = memoizeFactory({
  maxCachedArgsSize: Number.POSITIVE_INFINITY,
  cacheDuration: 60 * 60 * 1000,
});

async function _getEmailFromSuperTokens(userId: string): Promise<string | undefined> {
  try {
    const user = await SuperTokensNode.getUser(userId);
    return user?.emails[0];
  } catch {
    return undefined;
  }
}

export const getEmailFromSession = memoizeForEmails(_getEmailFromSuperTokens);
