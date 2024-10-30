'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import NextTopLoader from 'nextjs-toploader';
import React from 'react';
import { SuperTokensWrapper } from 'supertokens-auth-react';

// import { ChakraProvider } from '../../infrastructures/useClient/chakra';

import { Provider } from '@/components/ui/provider';
import { Toaster } from '@/components/ui/toaster';
import { ensureSuperTokensReactInit, setRouter } from '@/infrastructures/supertokens/frontendConfig';
import { backendTrpcReact, backendTrpcReactClient } from '@/infrastructures/trpcBackend/client';
import { system } from '@/system';
// import { theme } from '@/theme';

ensureSuperTokensReactInit();

const queryClient = new QueryClient();

export const Providers: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  setRouter(useRouter(), usePathname() || globalThis.location.pathname);
  console.log('colors.brand.500', system.token('colors.brand.500'));
  console.log('colors.brand.solid', system.token('colors.brand.solid'));
  console.log('colors.red.500', system.token('colors.red.500'));
  console.log('colors.red.solid', system.token('colors.red.solid'));

  return (
    <SuperTokensWrapper>
      <backendTrpcReact.Provider client={backendTrpcReactClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          {/* <ChakraProvider theme={theme}>*/}
          <Provider system={system}>
            <NextTopLoader color={system.token('colors.brand.solid')} shadow={false} showSpinner={false} />
            {children}
            <Toaster />
          </Provider>
          {/* </ChakraProvider>*/}
        </QueryClientProvider>
      </backendTrpcReact.Provider>
    </SuperTokensWrapper>
  );
};
