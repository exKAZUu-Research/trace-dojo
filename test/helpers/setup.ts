import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(cleanup);

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

if (!globalThis.matchMedia) {
  globalThis.matchMedia = () =>
    ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    }) as never;
}

// jsdom has no layout engine; CodeMirror still measures ranges while editing.
if (typeof Range !== 'undefined') {
  if (!Range.prototype.getClientRects) {
    // oxlint-disable-next-line unicorn/no-null -- DOMRectList.item returns null for a missing rectangle.
    Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  }
  if (!Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = () => new DOMRect();
  }
}
