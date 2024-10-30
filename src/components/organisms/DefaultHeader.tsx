import { AvatarFallback, AvatarRoot, Box, Heading, HStack, Icon } from '@chakra-ui/react';
import type { NextPage } from 'next';
import NextLink from 'next/link';
import React from 'react';
import { MdKeyboardArrowDown, MdOutlineHome, MdOutlinePerson, MdOutlineSettings } from 'react-icons/md';
import SuperTokensNode from 'supertokens-node';

import { APP_NAME } from '../../constants';
import { prisma } from '../../infrastructures/prisma';
import { getNullableSessionOnServer } from '../../utils/session';
import { Button } from '../ui/button';

import { SignOutMenuItem } from '@/components/organisms/SignOutMenuItem';
import { MenuContent, MenuItem, MenuRoot, MenuSeparator, MenuTrigger } from '@/components/ui/menu';

export { MdOutlineHome, MdOutlinePerson, MdOutlineSettings, MdKeyboardArrowDown } from 'react-icons/md';

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
        <Heading asChild>
          <NextLink href="/">
            <HStack>
              <Icon color="brand.500">
                <MdOutlineHome />
              </Icon>
              {APP_NAME}
            </HStack>
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
                <AvatarRoot bg="gray.muted" size="sm">
                  <AvatarFallback>
                    <MdOutlinePerson />
                  </AvatarFallback>
                </AvatarRoot>
                {superTokensUser?.emails[0] ?? user.displayName}
                <MdKeyboardArrowDown />
              </Button>
            </MenuTrigger>

            <MenuContent>
              <MenuItem asChild value="settings">
                <NextLink href="/settings">
                  <MdOutlineSettings />
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
