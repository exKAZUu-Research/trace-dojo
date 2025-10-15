import { useMemo } from 'react';

const macosPlatforms = /(macintosh|macintel|macppc|mac68k|macos)/i;

export function isMacOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return macosPlatforms.test(navigator.userAgent.toLowerCase());
}

export function useIsMacOS(): boolean {
  return useMemo(() => isMacOS(), []);
}
