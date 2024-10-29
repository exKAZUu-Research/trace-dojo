'use client';

import { defaultSystem } from '@chakra-ui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { ThemeProvider } from 'next-themes';
import NextTopLoader from 'nextjs-toploader';
import React from 'react';
import { SuperTokensWrapper } from 'supertokens-auth-react';

import { ensureSuperTokensReactInit, setRouter } from '../../infrastructures/supertokens/frontendConfig';
import { backendTrpcReact, backendTrpcReactClient } from '../../infrastructures/trpcBackend/client';
import { system } from '@/system'; // Assuming system.ts has been updated to export system

import { Provider } from '@/components/ui/provider';

ensureSuperTokensReactInit();

const queryClient = new QueryClient();

export const Providers: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  setRouter(useRouter(), usePathname() || globalThis.location.pathname);

  return (
    <SuperTokensWrapper>
      <backendTrpcReact.Provider client={backendTrpcReactClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <Provider value={system}>
            <ThemeProvider disableTransitionOnChange attribute="class">
              <PageTransitionProgressBar />
              {children}
            </ThemeProvider>
          </Provider>
        </QueryClientProvider>
      </backendTrpcReact.Provider>
    </SuperTokensWrapper>
  );
};

const PageTransitionProgressBar: React.FC = () => {
  // Using semantic token for brand color
  return (
    <NextTopLoader color={system.theme.semanticTokens.colors.brand.solid.value} shadow={false} showSpinner={false} />
  );
};
