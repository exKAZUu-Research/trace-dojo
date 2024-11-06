import { cookies } from 'next/headers';
import React, { Suspense } from 'react';

import { TryRefreshComponent } from '@/components/molecules/TryRefreshComponent';
import { DefaultFooter } from '@/components/organisms/DefaultFooter';
import { DefaultHeader } from '@/components/organisms/DefaultHeader';
import { Container, Spinner } from '@/infrastructures/useClient/chakra';
import type { LayoutComponent } from '@/types';
import { getNullableSessionOnServer } from '@/utils/session';

const DefaultLayout: LayoutComponent = async ({ children }) => {
  const { hasToken, session } = await getNullableSessionOnServer(await cookies());
  if (!session && hasToken) return <TryRefreshComponent key={Date.now()} />;

  return (
    <>
      <DefaultHeader />
      <Suspense fallback={<Spinner left="50%" position="fixed" top="50%" transform="translate(-50%, -50%)" />}>
        <Container pb={16} pt={12}>
          {children}
        </Container>
      </Suspense>
      <DefaultFooter />
    </>
  );
};

export default DefaultLayout;
