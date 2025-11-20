'use client';

import { MdKeyboardArrowDown, MdOutlinePerson, MdOutlineSettings } from 'react-icons/md';

import { SignOutMenuItem } from './SignOutMenuItem';

import { NextLinkWithoutPrefetch } from '@/components/atoms/NextLinkWithoutPrefetch';
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

interface Props {
  displayName: string;
}

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
        <MenuItem as={NextLinkWithoutPrefetch} href="/settings" icon={<Icon as={MdOutlineSettings} />}>
          設定
        </MenuItem>
        <MenuDivider />
        <SignOutMenuItem />
      </MenuList>
    </Menu>
  );
};
