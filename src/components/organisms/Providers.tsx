'use client';

import { CacheProvider } from '@chakra-ui/next-js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import React from 'react';
import { SuperTokensWrapper } from 'supertokens-auth-react';

import { ensureSuperTokensReactInit, setRouter } from '../../infrastructures/supertokens/frontendConfig';
import { ChakraProvider } from '../../infrastructures/useClient/chakra';
import { theme } from '../../theme';

ensureSuperTokensReactInit();

const queryClient = new QueryClient();

export const Providers: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  setRouter(useRouter(), usePathname() || window.location.pathname);

  return (
    <SuperTokensWrapper>
      <QueryClientProvider client={queryClient}>
        {/* Chakra UI */}
        <CacheProvider>
          <ChakraProvider theme={theme}>{children}</ChakraProvider>
        </CacheProvider>
      </QueryClientProvider>
    </SuperTokensWrapper>
  );
};
