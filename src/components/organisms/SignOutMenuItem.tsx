'use client';

import { useRouter } from 'next/navigation';
import React from 'react';
import { MdOutlineLogout } from 'react-icons/md';
import { signOut } from 'supertokens-auth-react/recipe/session';

import { clearAllCaches } from '../../asyncFunctions/cache/actions';
import { Icon, MenuItem } from '../../infrastructures/useClient/chakra';

export const SignOutMenuItem: React.FC = () => {
  const router = useRouter();
  return (
    <MenuItem
      icon={<Icon as={MdOutlineLogout} />}
      onClick={async () => {
        await signOut();
        router.push('/');
        // サインイン/アップに伴う画面表示の変更を反映するために、全ページのキャッシュを削除する。
        void clearAllCaches();
      }}
    >
      サインアウト
    </MenuItem>
  );
};
