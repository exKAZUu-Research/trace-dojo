'use client';

import { CacheProvider } from '@chakra-ui/next-js';
import { ChakraProvider } from '@chakra-ui/react';
import { usePathname, useRouter } from 'next/navigation';
import React from 'react';
import { SuperTokensWrapper } from 'supertokens-auth-react';

import { ensureSuperTokensReactInit, setRouter } from '../../infrastructures/supertokens/frontend';
import { theme } from '../../theme';

ensureSuperTokensReactInit();

export const Providers: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  setRouter(useRouter(), usePathname() || window.location.pathname);

  return (
    <SuperTokensWrapper>
      {/* Chakra UI */}
      <CacheProvider>
        <ChakraProvider theme={theme}>{children}</ChakraProvider>
      </CacheProvider>
    </SuperTokensWrapper>
  );
};
