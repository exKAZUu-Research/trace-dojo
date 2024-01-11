import { Box, Button, FormControl, FormLabel, Input } from '@chakra-ui/react';
import type { NextPage } from 'next';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { zfd } from 'zod-form-data';

import { prisma } from '../../../infrastructures/prisma';
import { getNonNullableSessionOnServer } from '../../../utils/session';

const SettingsPage: NextPage = async () => {
  const session = await getNonNullableSessionOnServer();
  const user = await prisma.user.findUnique({
    where: {
      id: session.getUserId(),
    },
  });

  return (
    <Box>
      <form action={updateDisplayName}>
        <FormControl>
          <FormLabel>あなたの表示名</FormLabel>
          <Input defaultValue={user?.displayName} name="displayName" type="text" />
        </FormControl>
        <Button colorScheme="blue" mt={4} type="submit">
          更新
        </Button>
      </form>
    </Box>
  );
};

const inputSchema = zfd.formData({
  displayName: z.string().min(1),
});

async function updateDisplayName(formData: FormData): Promise<void> {
  'use server';
  const input = inputSchema.parse(formData);
  const session = await getNonNullableSessionOnServer();
  await prisma.user.update({
    where: {
      id: session.getUserId(),
    },
    data: {
      displayName: input.displayName,
    },
  });

  // ユーザ名の変更を全ページに反映する。
  revalidatePath('/', 'layout');
}

export default SettingsPage;
