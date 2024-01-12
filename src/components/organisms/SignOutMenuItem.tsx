'use client';
import { MenuItem } from '@chakra-ui/react';
import { useRouter } from 'next/navigation';
import React from 'react';
import { FaSignOutAlt } from 'react-icons/fa';
import { signOut } from 'supertokens-auth-react/recipe/session';

export const SignOutMenuItem: React.FC = () => {
  const router = useRouter();
  return (
    <MenuItem
      icon={<FaSignOutAlt size="1.5em" />}
      onClick={async () => {
        await signOut();
        router.push('/');
      }}
    >
      サインアウト
    </MenuItem>
  );
};
