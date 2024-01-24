import type React from 'react';

export interface LayoutProps {
  children: React.ReactNode;
}

export type LayoutComponent = React.FC<LayoutProps>;

export type CellColor = 'red' | 'green' | 'blue';
