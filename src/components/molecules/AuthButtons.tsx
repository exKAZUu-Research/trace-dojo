'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import type React from 'react';
import { Suspense } from 'react';

import { NextLinkWithoutPrefetch } from '../atoms/NextLinkWithoutPrefetch';

import { Button } from '@/infrastructures/useClient/chakra';

export const AuthButtons: React.FC = () => (
  // `useSearchParams` suspends while a page is prerendered.
  <Suspense fallback={<AuthButtonsPresentation />}>
    <AuthButtonsWithRedirectToPath />
  </Suspense>
);

const AuthButtonsWithRedirectToPath: React.FC = () => {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const isAuthPage = pathname === '/auth' || pathname.startsWith('/auth/');

  return <AuthButtonsPresentation redirectToPath={isAuthPage ? undefined : `${pathname}${search && `?${search}`}`} />;
};

const AuthButtonsPresentation: React.FC<{ redirectToPath?: string }> = ({ redirectToPath }) => (
  <>
    <Button
      as={NextLinkWithoutPrefetch}
      colorScheme="brand"
      href={{ pathname: '/auth', query: { ...(redirectToPath && { redirectToPath }) } }}
      mr={2}
      variant="outline"
    >
      サインイン
    </Button>
    <Button
      as={NextLinkWithoutPrefetch}
      colorScheme="brand"
      href={{ pathname: '/auth', query: { show: 'signup', ...(redirectToPath && { redirectToPath }) } }}
    >
      新規登録
    </Button>
  </>
);
