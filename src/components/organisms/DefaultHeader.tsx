'use client';

import type { BoxProps } from '@chakra-ui/react';
import {
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
} from '@chakra-ui/react';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import React from 'react';
import { FaChevronDown, FaCog, FaSignOutAlt, FaUser } from 'react-icons/fa';
import { signOut, useSessionContext } from 'supertokens-auth-react/recipe/session';

import { APP_NAME } from '../../constants';

const MENU_ITEMS: readonly [string, string][] = [
  ['/courses', '科目一覧'],
  ['/submissions', '提出一覧'],
];

export const DefaultHeader: React.FC<BoxProps> = (props) => {
  const session = useSessionContext();

  const router = useRouter();

  return (
    <HStack borderBottomWidth={1} h={16} px={4} spacing={4} {...props}>
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
        {!session.loading && session.doesSessionExist ? (
          <Menu direction="rtl">
            <MenuButton
              as={Button}
              leftIcon={<Icon as={FaUser} boxSize={5} />}
              rightIcon={<FaChevronDown />}
              variant="ghost"
            >
              {`User ${session.userId.slice(0, 4)}...${session.userId.slice(-4)}`}
            </MenuButton>
            <MenuList>
              <MenuItem as={NextLink} href="/settings" icon={<Icon as={FaCog} boxSize={5} />}>
                設定
              </MenuItem>
              <MenuDivider />
              <MenuItem
                icon={<Icon as={FaSignOutAlt} boxSize={5} />}
                onClick={async () => {
                  await signOut();
                  router.push('/');
                }}
              >
                サインアウト
              </MenuItem>
            </MenuList>
          </Menu>
        ) : (
          <Button as={NextLink} colorScheme="brand" href="/auth" isLoading={session.loading}>
            サインイン
          </Button>
        )}
      </Box>
    </HStack>
  );
};
