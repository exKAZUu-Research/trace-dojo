import { VersionOverlay } from '@willbooster/shared-lib-react';
import type { Metadata, Viewport } from 'next';

import { Providers } from '../components/organisms/Providers';
import { APP_DESCRIPTION, APP_NAME } from '../constants';
import type { LayoutComponent } from '../types';

export const metadata: Metadata = {
  title: { absolute: APP_NAME, template: `%s | ${APP_NAME}` },
  description: APP_DESCRIPTION,
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

const RootLayout: LayoutComponent = ({ children }) => {
  return (
    <html lang="ja_JP">
      <body>
        <Providers>{children}</Providers>

        <VersionOverlay />
      </body>
    </html>
  );
};

export default RootLayout;
