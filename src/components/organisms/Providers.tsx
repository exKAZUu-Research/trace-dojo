'use client';

import { CacheProvider } from '@chakra-ui/next-js';
import { ChakraProvider } from '@chakra-ui/react';

import { theme } from '../../theme';

export const Providers: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return (
    <>
      {/* Chakra UI */}
      <CacheProvider>
        <ChakraProvider theme={theme}>{children}</ChakraProvider>
      </CacheProvider>
    </>
  );
};
