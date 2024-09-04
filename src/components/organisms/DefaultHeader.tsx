import type { NextPage } from 'next';
import NextLink from 'next/link';
import React from 'react';
import { FaChevronDown, FaCog, FaUser } from 'react-icons/fa';
import SuperTokensNode from 'supertokens-node';

import { APP_NAME } from '../../constants';
import { prisma } from '../../infrastructures/prisma';
import {
  Box,
  Button,
  Heading,
  HStack,
  Menu,
  MenuButton,
  MenuDivider,
  MenuItem,
  MenuList,
} from '../../infrastructures/useClient/chakra';
import { getNullableSessionOnServer } from '../../utils/session';

import { SignOutMenuItem } from './SignOutMenuItem';

const MENU_ITEMS: readonly [string, string][] = [['/courses', '科目一覧']];

export const DefaultHeader: NextPage = async () => {
  const { session } = await getNullableSessionOnServer();
  const superTokensUser = session && (await SuperTokensNode.getUser(session.getUserId()));

  const user =
    session &&
    (await prisma.user.findUnique({
      where: {
        id: session.getUserId(),
      },
    }));

  return (
    <HStack borderBottomWidth={1} h={16} px={4} spacing={4}>
      <HStack flexGrow={1} flexShrink={1} spacing={8}>
        <Heading as={NextLink} href="/" size="md">
          {APP_NAME}
        </Heading>
        <HStack flexGrow={0} flexShrink={0} spacing={0}>
          {MENU_ITEMS.map(([href, label]) => (
            <Button key={href} as={NextLink} href={href} variant="ghost">
              {label}
            </Button>
          ))}
        </HStack>
      </HStack>
      <Box flexGrow={0} flexShrink={0}>
        {user?.displayName ? (
          <Menu direction="rtl">
            <MenuButton as={Button} leftIcon={<FaUser size="1em" />} rightIcon={<FaChevronDown />} variant="ghost">
              {superTokensUser?.emails[0] ?? user.displayName}
            </MenuButton>
            <MenuList>
              <MenuItem as={NextLink} href="/settings" icon={<FaCog size="1.5em" />}>
                設定
              </MenuItem>
              <MenuDivider />
              <SignOutMenuItem />
            </MenuList>
          </Menu>
        ) : (
          <Button as={NextLink} colorScheme="brand" href="/auth">
            サインイン
          </Button>
        )}
      </Box>
    </HStack>
  );
};
