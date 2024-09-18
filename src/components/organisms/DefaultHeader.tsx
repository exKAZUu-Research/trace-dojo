import type { NextPage } from 'next';
import NextLink from 'next/link';
import React from 'react';
import SuperTokensNode from 'supertokens-node';

import { APP_NAME } from '../../constants';
import { prisma } from '../../infrastructures/prisma';
import {
  Avatar,
  Box,
  Button,
  Heading,
  HStack,
  Icon,
  Menu,
  MenuButton,
  MenuDivider,
  MenuItem,
  MenuList,
} from '../../infrastructures/useClient/chakra';
import {
  MdKeyboardArrowDown,
  MdOutlineHome,
  MdOutlinePerson,
  MdOutlineSettings,
} from '../../infrastructures/useClient/icons';
import { getNullableSessionOnServer } from '../../utils/session';

import { SignOutMenuItem } from './SignOutMenuItem';

export const DefaultHeader: NextPage = async () => {
  const { session } = await getNullableSessionOnServer();
  const superTokensUser = session && (await SuperTokensNode.getUser(session.superTokensUserId));

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
        <Heading as={NextLink} href="/" size="md">
          <Icon as={MdOutlineHome} color="brand.500" mr={1} />
          {APP_NAME}
        </Heading>
      </HStack>

      <Box flexGrow={0} flexShrink={0}>
        {user?.displayName ? (
          <Menu direction="rtl">
            <MenuButton
              as={Button}
              leftIcon={<Avatar bg="gray.400" icon={<Icon as={MdOutlinePerson} />} size="sm" />}
              rightIcon={<Icon as={MdKeyboardArrowDown} />}
              variant="ghost"
            >
              {superTokensUser?.emails[0] ?? user.displayName}
            </MenuButton>

            <MenuList>
              <MenuItem as={NextLink} href="/settings" icon={<Icon as={MdOutlineSettings} />}>
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
