import { Container, Spinner } from '@chakra-ui/react';
import React, { Suspense } from 'react';

import { TryRefreshComponent } from '../../components/molecules/TryRefreshComponent';
import { DefaultFooter } from '../../components/organisms/DefaultFooter';
import { DefaultHeader } from '../../components/organisms/DefaultHeader';
import type { LayoutComponent } from '../../types';
import { getNullableSessionOnServer } from '../../utils/session';

const DefaultLayout: LayoutComponent = async ({ children }) => {
  const { hasToken, session } = await getNullableSessionOnServer();
  if (!session && hasToken) return <TryRefreshComponent key={Date.now()} />;

  return (
    <>
      <DefaultHeader />
      <Suspense
        fallback={
          <Spinner
            css={{
              position: 'fixed',
              left: '50%',
              top: '50%',
              transform: 'translate(-50%, -50%)',
            }}
          />
        }
      >
        <Container css={{ paddingBottom: 16, paddingTop: 12 }}>{children}</Container>
      </Suspense>
      <DefaultFooter />
    </>
  );
};

export default DefaultLayout;
