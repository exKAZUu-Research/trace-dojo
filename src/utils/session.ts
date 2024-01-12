import { cookies, headers } from 'next/headers';
import { getSSRSession } from 'supertokens-node/nextjs';
import type { SessionContainer } from 'supertokens-node/recipe/session';

import { logger } from '../infrastructures/pino';
import { prisma } from '../infrastructures/prisma';
import { ensureSuperTokensInit } from '../infrastructures/supertokens/backendConfig';

ensureSuperTokensInit();

export interface SessionOnServerLayout {
  session: SessionContainer | undefined;
  hasToken: boolean;
  /**
   * This allows us to protect our routes based on the current session claims.
   * For example this will be true if email verification is required but the user has not verified their email.
   */
  hasInvalidClaims: boolean;
  error: unknown | undefined;
}

export async function getNullableSessionOnServer(): Promise<SessionOnServerLayout> {
  let session: SessionContainer | undefined;
  let hasToken = false;
  let hasInvalidClaims = false;
  let error: unknown | undefined = undefined;

  try {
    ({ hasInvalidClaims, hasToken, session } = await getSSRSession(cookies().getAll(), headers()));
    if (session) {
      void upsertUserToPrisma(session.getUserId());
    }
  } catch (error_: unknown) {
    error = error_;
  }
  return { session, hasToken, hasInvalidClaims, error };
}

export async function getNonNullableSessionOnServer(): Promise<SessionContainer> {
  const { session } = await getSSRSession(cookies().getAll(), headers());
  if (!session) {
    throw new Error('Failed to get a session.');
  }
  void upsertUserToPrisma(session.getUserId());
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
