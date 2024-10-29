'use client';

import { CacheProvider } from '@chakra-ui/next-js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import NextTopLoader from 'nextjs-toploader';
import React from 'react';
import { SuperTokensWrapper } from 'supertokens-auth-react';

import { ChakraProvider, theme } from '../../infrastructures/useClient/chakra';

import { Provider } from '@/components/ui/provider';
import { Toaster } from '@/components/ui/toaster';
import { ensureSuperTokensReactInit, setRouter } from '@/infrastructures/supertokens/frontendConfig';
import { backendTrpcReact, backendTrpcReactClient } from '@/infrastructures/trpcBackend/client';
import { system } from '@/system';

ensureSuperTokensReactInit();

const queryClient = new QueryClient();

export const Providers: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  setRouter(useRouter(), usePathname() || globalThis.location.pathname);

  return (
    <SuperTokensWrapper>
      <backendTrpcReact.Provider client={backendTrpcReactClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <CacheProvider>
            <ChakraProvider theme={theme}>
              <Provider system={system}>
                <NextTopLoader color={system.token('colors.brand.solid')} shadow={false} showSpinner={false} />
                {children}
                <Toaster />
              </Provider>
            </ChakraProvider>
          </CacheProvider>
        </QueryClientProvider>
      </backendTrpcReact.Provider>
    </SuperTokensWrapper>
  );
};
