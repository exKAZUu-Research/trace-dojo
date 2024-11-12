'use client';

import NextLink from 'next/link';
import React from 'react';
import { MdKeyboardArrowDown, MdOutlinePerson, MdOutlineSettings } from 'react-icons/md';

import { SignOutMenuItem } from './SignOutMenuItem';

import {
  Avatar,
  Button,
  Icon,
  Menu,
  MenuButton,
  MenuDivider,
  MenuItem,
  MenuList,
} from '@/infrastructures/useClient/chakra';

type Props = {
  displayName: string;
};

export const DefaultHeaderMenu: React.FC<Props> = (props) => {
  return (
    <Menu direction="rtl">
      <MenuButton
        as={Button}
        leftIcon={<Avatar bg="gray.400" icon={<Icon as={MdOutlinePerson} />} size="sm" />}
        rightIcon={<Icon as={MdKeyboardArrowDown} />}
        variant="ghost"
      >
        {props.displayName}
      </MenuButton>

      <MenuList>
        <MenuItem as={NextLink} href="/settings" icon={<Icon as={MdOutlineSettings} />}>
          設定
        </MenuItem>
        <MenuDivider />
        <SignOutMenuItem />
      </MenuList>
    </Menu>
  );
};
