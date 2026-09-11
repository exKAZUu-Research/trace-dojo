import 'server-only';

import { memoizeFactory } from 'at-decorators';
import type { ReadonlyRequestCookies } from 'next/dist/server/web/spec-extension/adapters/request-cookies';
import SuperTokensNode from 'supertokens-node';

import { users } from '../../db/schema';
import type { SessionOnNode } from './sessionOnNode';
import { getSessionOnServer } from './sessionOnServer';

import { logger } from '@/infrastructures/pino';
import { db } from '@/infrastructures/database';

export interface SessionOnServer {
  session: SessionOnNode | undefined;
  hasToken: boolean;
  error: unknown;
}

export async function getNullableSessionOnServer(cookies: ReadonlyRequestCookies): Promise<SessionOnServer> {
  let session: SessionOnNode | undefined;
  let hasToken = false;
  let error: unknown = undefined;

  try {
    ({ hasToken, session } = await getSessionOnServer(cookies));
    if (session) {
      void upsertUser(session.superTokensUserId);
    }
  } catch (error_: unknown) {
    error = error_;
  }
  return { session, hasToken, error };
}

export async function getNonNullableSessionOnServer(cookies: ReadonlyRequestCookies): Promise<SessionOnNode> {
  const { session } = await getSessionOnServer(cookies);
  if (!session) {
    throw new Error('Failed to get a session.');
  }
  void upsertUser(session.superTokensUserId);
  return session;
}

const upsertedUserIds = new Set<string>();

async function upsertUser(id: string): Promise<void> {
  if (upsertedUserIds.has(id)) return;

  upsertedUserIds.add(id);
  const user = db.insert(users).values({ id, displayName: id }).onConflictDoNothing().returning().get();
  logger.debug('User upserted: %o', user);
}

const memoizeForEmails = memoizeFactory({
  maxCacheSizePerTarget: Number.POSITIVE_INFINITY,
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
