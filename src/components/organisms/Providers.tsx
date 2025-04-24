'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import NextTopLoader from 'nextjs-toploader';
import type React from 'react';
import { SuperTokensWrapper } from 'supertokens-auth-react';

import { ensureSuperTokensReactInit, setRouter } from '../../infrastructures/supertokens/frontendConfig';
import { backendTrpcReact, backendTrpcReactClient } from '../../infrastructures/trpcBackend/client';

import { ChakraProvider, useTheme } from '@/infrastructures/useClient/chakra';
import { theme } from '@/theme';

ensureSuperTokensReactInit();

const queryClient = new QueryClient();

export const Providers: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  setRouter(useRouter(), usePathname() || globalThis.location.pathname);

  return (
    <SuperTokensWrapper>
      <backendTrpcReact.Provider client={backendTrpcReactClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <ChakraProvider theme={theme}>
            <PageTransitionProgressBar />
            {children}
          </ChakraProvider>
        </QueryClientProvider>
      </backendTrpcReact.Provider>
    </SuperTokensWrapper>
  );
};

const PageTransitionProgressBar: React.FC = () => {
  const theme = useTheme() as { colors: { brand: Record<number, string> } };

  return <NextTopLoader color={theme.colors.brand[500]} shadow={false} showSpinner={false} />;
};
