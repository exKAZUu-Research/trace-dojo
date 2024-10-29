import { Box, Heading, HStack, Icon } from '@chakra-ui/react';
import type { NextPage } from 'next';
import NextLink from 'next/link';
import React from 'react';
import SuperTokensNode from 'supertokens-node';

import { APP_NAME } from '../../constants';
import { prisma } from '../../infrastructures/prisma';
import {
  MdKeyboardArrowDown,
  MdOutlineHome,
  MdOutlinePerson,
  MdOutlineSettings,
} from '../../infrastructures/useClient/icons';
import { getNullableSessionOnServer } from '../../utils/session';
import { Avatar } from '../ui/avatar';
import { Button } from '../ui/button';
import { MenuContent, MenuItem, MenuRoot, MenuSeparator, MenuTrigger } from '../ui/menu';

import { SignOutMenuItem } from './SignOutMenuItem';

const MENU_ITEMS: readonly [string, string][] = [['/usage', '使い方']];
const ADMIN_MENU_ITEMS = [...MENU_ITEMS, ['/admin/statistics', '統計情報']];

export const DefaultHeader: NextPage = async () => {
  const { session } = await getNullableSessionOnServer();
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
    <HStack bg="white" gap={4} h={16} px={4}>
      <HStack flexGrow={1} flexShrink={1} gap={8}>
        <Heading asChild size="md">
          <NextLink href="/">
            <Icon as={MdOutlineHome} color="brand.500" mr={1} />
            {APP_NAME}
          </NextLink>
        </Heading>
        <HStack flexGrow={0} flexShrink={0} gap={0}>
          {(isAdmin ? ADMIN_MENU_ITEMS : MENU_ITEMS).map(([href, label]) => (
            <Button key={href} asChild variant="ghost">
              <NextLink href={href}>{label}</NextLink>
            </Button>
          ))}
        </HStack>
      </HStack>

      <Box flexGrow={0} flexShrink={0}>
        {user?.displayName ? (
          <MenuRoot>
            <MenuTrigger asChild>
              <Button variant="ghost">
                <Avatar bg="gray.400" icon={<MdOutlinePerson />} size="sm" />
                {superTokensUser?.emails[0] ?? user.displayName}
                <MdKeyboardArrowDown />
              </Button>
            </MenuTrigger>

            <MenuContent>
              <MenuItem asChild value="settings">
                <NextLink href="/settings">
                  <Icon as={MdOutlineSettings} mr={2} />
                  設定
                </NextLink>
              </MenuItem>
              <MenuSeparator />
              <SignOutMenuItem />
            </MenuContent>
          </MenuRoot>
        ) : (
          <>
            <Button asChild colorPalette="brand" mr={2} variant="outline">
              <NextLink href="/auth">サインイン</NextLink>
            </Button>
            <Button asChild colorPalette="brand">
              <NextLink href="/auth?show=signup">新規登録</NextLink>
            </Button>
          </>
        )}
      </Box>
    </HStack>
  );
};
