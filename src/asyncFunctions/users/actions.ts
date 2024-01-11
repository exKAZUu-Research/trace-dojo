'use server';

import { prisma } from '../../infrastructures/prisma';
import { getSessionOnServerLayout } from '../../utils/session';

export async function getCurrentDisplayName(): Promise<string | undefined> {
  const { session } = await getSessionOnServerLayout();
  if (!session) return;

  const user = await prisma.user.findUnique({
    where: {
      superTokensUserId: session.getUserId(),
    },
  });
  return user?.displayName;
}
