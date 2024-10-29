'use client';

import { ChakraProvider, SystemContext } from '@chakra-ui/react';
import { ColorModeProvider } from './color-mode';

export function Provider(props: React.PropsWithChildren<{ system: SystemContext }>) {
  return (
    <ChakraProvider value={props.system}>
      <ColorModeProvider>{props.children}</ColorModeProvider>
    </ChakraProvider>
  );
}
