'use client';

import { CacheProvider } from '@chakra-ui/next-js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import NextTopLoader from 'nextjs-toploader';
import React from 'react';
import { SuperTokensWrapper } from 'supertokens-auth-react';

import { ensureSuperTokensReactInit, setRouter } from '../../infrastructures/supertokens/frontendConfig';
import { backendTrpcReact, backendTrpcReactClient } from '../../infrastructures/trpcBackend/client';
import { ChakraProvider, useTheme } from '../../infrastructures/useClient/chakra';
import { theme } from '../../theme';

import { ErrorBoundary } from './ErrorBoundary';

ensureSuperTokensReactInit();

const queryClient = new QueryClient();

export const Providers: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  setRouter(useRouter(), usePathname() || window.location.pathname);

  return (
    <CacheProvider>
      <ChakraProvider theme={theme}>
        <ErrorBoundary>
          <SuperTokensWrapper>
            <backendTrpcReact.Provider client={backendTrpcReactClient} queryClient={queryClient}>
              <QueryClientProvider client={queryClient}>
                <PageTransitionProgressBar />
                {children}
              </QueryClientProvider>
            </backendTrpcReact.Provider>
          </SuperTokensWrapper>
        </ErrorBoundary>
      </ChakraProvider>
    </CacheProvider>
  );
};

const PageTransitionProgressBar: React.FC = () => {
  const theme = useTheme();

  return <NextTopLoader color={theme.colors.brand[500]} shadow={false} showSpinner={false} />;
};
