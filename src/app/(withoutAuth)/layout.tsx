import React, { Suspense } from 'react';

import { DefaultFooter } from '../../components/organisms/DefaultFooter';
import { DefaultHeader } from '../../components/organisms/DefaultHeader';
import { Container, Spinner } from '../../infrastructures/useClient/chakra';
import type { LayoutComponent } from '../../types';

const DefaultLayout: LayoutComponent = ({ children }) => {
  return (
    <>
      <DefaultHeader />
      <Suspense fallback={<Spinner left="50%" position="fixed" top="50%" transform="translate(-50%, -50%)" />}>
        <Container pb={16} pt={8}>
          {children}
        </Container>
      </Suspense>
      <DefaultFooter />
    </>
  );
};

export default DefaultLayout;
