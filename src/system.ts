import { createSystem, defaultConfig, defineConfig } from '@chakra-ui/react';

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

const customConfig = defineConfig({
  theme: {
    tokens: {
      colors: {
        brand: defaultConfig.theme!.tokens!.colors!.red,
      },
      fonts: {
        body: { value: sansSerif },
        heading: { value: sansSerif },
        mono: { value: monospace },
      },
    },
    semanticTokens: {
      colors: {
        brand: defaultConfig.theme!.semanticTokens!.colors!.red,
      },
    },
    recipes: {
      card: {
        base: {
          container: {
            // shadow: 'none',
          },
        },
      },
      container: {
        base: {
          maxW: 'container.xl',
        },
      },
      formLabel: {
        base: {
          fontWeight: 'bold',
        },
      },
      heading: {
        // defaultVariants: { size: 'lg' },
      },
      icon: {
        base: {
          boxSize: '1.5em',
          verticalAlign: '-0.375em',
        },
      },
      link: {
        base: {
          color: 'brand.solid',
        },
      },
      switch: {
        defaultVariants: {
          colorPalette: 'brand',
        },
      },
      tabs: {
        defaultVariants: {
          colorPalette: 'brand',
        },
      },
    },
  },
  globalCss: {
    body: {
      bg: 'gray.subtle',
      lineHeight: '1.75',
      touchAction: 'manipulation',
    },
  },
});

export const system = createSystem(defaultConfig, customConfig);
