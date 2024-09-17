import { defineStyleConfig, extendTheme, theme as defaultTheme } from '@chakra-ui/react';

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
    brand: defaultTheme.colors.green,
  },
  fonts: {
    body: sansSerif,
    heading: sansSerif,
    mono: monospace,
  },
  components: {
    Card: defineStyleConfig({
      defaultProps: {
        variant: 'outline',
      },
    }),
    Container: defineStyleConfig({
      baseStyle: {
        maxW: 'container.lg',
      },
    }),
    Heading: defineStyleConfig({
      defaultProps: {
        size: 'lg',
      },
    }),
    FormLabel: defineStyleConfig({
      baseStyle: {
        fontWeight: 'bold',
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
        lineHeight: 1.75,
        touchAction: 'manipulation',
      },
    },
  },
});
