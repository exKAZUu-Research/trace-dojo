const macosPlatforms = /(macintosh|macintel|macppc|mac68k|macos)/i;

export function isMacOS(): boolean {
  return typeof window !== 'undefined' && macosPlatforms.test(window.navigator.userAgent.toLowerCase());
}
