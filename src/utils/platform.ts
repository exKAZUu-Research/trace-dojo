const macosPlatforms = /(macintosh|macintel|macppc|mac68k|macos)/i;

export function isMacOS(): boolean {
  return macosPlatforms.test(window.navigator.userAgent.toLowerCase());
}
