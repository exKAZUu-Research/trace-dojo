'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import type React from 'react';

import { NextLinkWithoutPrefetch } from '../atoms/NextLinkWithoutPrefetch';

import { Button } from '@/infrastructures/useClient/chakra';

export const AuthButtons: React.FC = () => {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const redirectToPath = `${pathname}${search && `?${search}`}`;

  return (
    <>
      <Button
        as={NextLinkWithoutPrefetch}
        colorScheme="brand"
        href={{ pathname: '/auth', query: { redirectToPath } }}
        mr={2}
        variant="outline"
      >
        サインイン
      </Button>
      <Button
        as={NextLinkWithoutPrefetch}
        colorScheme="brand"
        href={{ pathname: '/auth', query: { show: 'signup', redirectToPath } }}
      >
        新規登録
      </Button>
    </>
  );
};
