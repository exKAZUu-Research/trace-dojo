import { useEffect, useState } from 'react';

const macosPlatforms = /(macintosh|macintel|macppc|mac68k|macos)/i;

export function isMacOS(): boolean {
  return macosPlatforms.test(globalThis.navigator.userAgent.toLowerCase());
}

export function useIsMacOS(): boolean {
  // Use a constant value to avoid hydration errors.
  const [macOS, setMacOS] = useState(false);
  useEffect(() => {
    setMacOS(isMacOS());
  }, []);
  return macOS;
}
