import type { NextPage } from 'next';
import { cookies } from 'next/headers';
import SuperTokensNode from 'supertokens-node';

import { NextLinkWithoutPrefetch } from '../atoms/NextLinkWithoutPrefetch';

import { DefaultHeaderMenu } from '@/components/organisms/DefaultHeaderMenu';
import { APP_NAME } from '@/constants';
import { prisma } from '@/infrastructures/prisma';
import { Box, Button, Heading, HStack, Icon } from '@/infrastructures/useClient/chakra';
import { MdOutlineHome } from '@/infrastructures/useClient/icons';
import { getNullableSessionOnServer } from '@/utils/session';

const MENU_ITEMS: readonly [string, string][] = [['/usage', '使い方']];
const ADMIN_MENU_ITEMS = [...MENU_ITEMS, ['/admin/statistics', '統計情報']];

export const DefaultHeader: NextPage = async () => {
  const { session } = await getNullableSessionOnServer(await cookies());
  const superTokensUser = session && (await SuperTokensNode.getUser(session.superTokensUserId));
  const isAdmin = superTokensUser?.emails[0]?.endsWith('@internet.ac.jp');

  const user =
    session &&
    (await prisma.user.findUnique({
      where: {
        id: session.superTokensUserId,
      },
    }));

  return (
    <HStack bg="white" h={16} px={4} spacing={4}>
      <HStack flexGrow={1} flexShrink={1} spacing={8}>
        <Heading as={NextLinkWithoutPrefetch} href="/" size="md">
          <Icon as={MdOutlineHome} color="brand.500" mr={1} />
          {APP_NAME}
        </Heading>
        <HStack flexGrow={0} flexShrink={0} spacing={0}>
          {(isAdmin ? ADMIN_MENU_ITEMS : MENU_ITEMS).map(([href, label]) => (
            <Button key={href} as={NextLinkWithoutPrefetch} href={href} variant="ghost">
              {label}
            </Button>
          ))}
        </HStack>
      </HStack>

      <Box flexGrow={0} flexShrink={0}>
        {user?.displayName ? (
          <DefaultHeaderMenu displayName={superTokensUser?.emails[0] ?? user.displayName} />
        ) : (
          <>
            <Button as={NextLinkWithoutPrefetch} colorScheme="brand" href="/auth" mr={2} variant="outline">
              サインイン
            </Button>
            <Button as={NextLinkWithoutPrefetch} colorScheme="brand" href="/auth?show=signup">
              新規登録
            </Button>
          </>
        )}
      </Box>
    </HStack>
  );
};
