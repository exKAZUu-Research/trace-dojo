'use server';

import { prisma } from '../../infrastructures/prisma';
import { getNullableSessionOnServer } from '../../utils/session';

export async function getCurrentDisplayName(): Promise<string | undefined> {
  const { session } = await getNullableSessionOnServer();
  if (!session) return;

  const user = await prisma.user.findUnique({
    where: {
      id: session.getUserId(),
    },
  });
  return user?.displayName;
}
