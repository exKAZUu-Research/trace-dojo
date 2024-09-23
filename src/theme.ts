import { cardAnatomy } from '@chakra-ui/anatomy';
import { createMultiStyleConfigHelpers, defineStyleConfig, extendTheme, theme as defaultTheme } from '@chakra-ui/react';

const cardStyleConfigHelpers = createMultiStyleConfigHelpers(cardAnatomy.keys);

const sansSerif = [
  // English
  '"Helvetica Neue"',
  'Arial',
  // Japanese
  '"Hiragino Kaku Gothic ProN"',
  '"Hiragino Sans"',
  'Meiryo',
  'sans-serif',
].join(',');

const monospace = [
  // English
  'SFMono-Regular',
  'Menlo',
  'Monaco',
  'Consolas',
  // Japanese
  '"Hiragino Kaku Gothic ProN"',
  '"Hiragino Sans"',
  'Meiryo',
  'monospace',
].join(',');

export const theme = extendTheme({
  colors: {
    brand: defaultTheme.colors.red,
  },
  fonts: {
    body: sansSerif,
    heading: sansSerif,
    mono: monospace,
  },
  components: {
    Card: cardStyleConfigHelpers.defineMultiStyleConfig({
      baseStyle: cardStyleConfigHelpers.definePartsStyle({
        container: {
          shadow: 'none',
        },
      }),
    }),
    Container: defineStyleConfig({
      baseStyle: {
        maxW: 'container.xl',
      },
    }),
    FormLabel: defineStyleConfig({
      baseStyle: {
        fontWeight: 'bold',
      },
    }),
    Heading: defineStyleConfig({
      defaultProps: {
        size: 'lg',
      },
    }),
    Icon: defineStyleConfig({
      baseStyle: {
        boxSize: '1.5em',
        verticalAlign: '-0.375em',
      },
    }),
    Link: defineStyleConfig({
      baseStyle: {
        color: 'brand.500',
      },
    }),
    Switch: defineStyleConfig({
      defaultProps: {
        colorScheme: 'brand',
      },
    }),
    Tabs: defineStyleConfig({
      defaultProps: {
        colorScheme: 'brand',
      },
    }),
  },
  styles: {
    global: {
      body: {
        bg: 'gray.100',
        lineHeight: 1.75,
        touchAction: 'manipulation',
      },
    },
  },
});
