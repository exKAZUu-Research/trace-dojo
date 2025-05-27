'use client';

import Link from 'next/link';
import type { ComponentProps } from 'react';

export const NextLinkWithoutPrefetch: React.FC<ComponentProps<typeof Link>> = ({ prefetch: _, ...props }) => (
  <Link {...props} prefetch={false}>
    {props.children}
  </Link>
);
