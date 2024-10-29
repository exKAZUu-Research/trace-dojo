'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { ThemeProvider } from 'next-themes';
import NextTopLoader from 'nextjs-toploader';
import React from 'react';
import { SuperTokensWrapper } from 'supertokens-auth-react';

import { Provider } from '@/components/ui/provider';
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
          <Provider system={system}>
            <ThemeProvider disableTransitionOnChange attribute="class">
              <NextTopLoader
                color={system.theme.semanticTokens.colors.brand.solid.value}
                shadow={false}
                showSpinner={false}
              />
              {children}
            </ThemeProvider>
          </Provider>
        </QueryClientProvider>
      </backendTrpcReact.Provider>
    </SuperTokensWrapper>
  );
};
