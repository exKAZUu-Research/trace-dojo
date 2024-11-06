import type { NextPage } from 'next';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { zfd } from 'zod-form-data';

import { prisma } from '@/infrastructures/prisma';
import { Button, FormControl, FormLabel, Input, VStack } from '@/infrastructures/useClient/chakra';
import { getNonNullableSessionOnServer } from '@/utils/session';

const SettingsPage: NextPage = async () => {
  const session = await getNonNullableSessionOnServer(await cookies());
  const user = await prisma.user.findUnique({
    where: {
      id: session.superTokensUserId,
    },
  });

  return (
    <form action={updateDisplayName}>
      <VStack align="stretch" spacing={4}>
        <FormControl>
          <FormLabel>あなたの表示名（現在は未使用のため、設定する必要はありません。）</FormLabel>
          <Input bg="white" defaultValue={user?.displayName} maxW="sm" name="displayName" type="text" />
        </FormControl>

        <Button alignSelf="flex-start" colorScheme="brand" type="submit">
          保存
        </Button>
      </VStack>
    </form>
  );
};

const inputSchema = zfd.formData({
  displayName: z.string().min(1),
});

async function updateDisplayName(formData: FormData): Promise<void> {
  'use server';
  const input = inputSchema.parse(formData);
  const session = await getNonNullableSessionOnServer(await cookies());
  await prisma.user.update({
    where: {
      id: session.superTokensUserId,
    },
    data: {
      displayName: input.displayName,
    },
  });

  // ユーザ名の変更を全ページに反映する。
  revalidatePath('/', 'layout');
}

export default SettingsPage;
