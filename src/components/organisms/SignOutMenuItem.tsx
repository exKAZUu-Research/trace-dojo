'use client';

import { MenuItem } from '@chakra-ui/react';
import { useRouter } from 'next/navigation';
import React from 'react';
import { MdOutlineLogout } from 'react-icons/md';
import { signOut } from 'supertokens-auth-react/recipe/session';

import { clearAllCaches } from '../../actions';

export const SignOutMenuItem: React.FC = () => {
  const router = useRouter();
  return (
    <MenuItem
      value="signOut"
      onClick={async () => {
        await signOut();
        router.push('/');
        // サインイン/アップに伴う画面表示の変更を反映するために、全ページのキャッシュを削除する。
        void clearAllCaches();
      }}
    >
      <MdOutlineLogout />
      サインアウト
    </MenuItem>
  );
};
