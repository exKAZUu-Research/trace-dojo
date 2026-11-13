// C17 Annex D ranges and Clang whitespace classification: https://github.com/llvm/llvm-project/blob/main/clang/lib/Lex/UnicodeCharSets.h
const C17_CHARACTER =
  /^[\u{00A8}\u{00AA}\u{00AD}\u{00AF}\u{00B2}-\u{00B5}\u{00B7}-\u{00BA}\u{00BC}-\u{00BE}\u{00C0}-\u{00D6}\u{00D8}-\u{00F6}\u{00F8}-\u{00FF}\u{0100}-\u{167F}\u{1681}-\u{180D}\u{180F}-\u{1FFF}\u{200B}-\u{200D}\u{202A}-\u{202E}\u{203F}-\u{2040}\u{2054}\u{2060}-\u{206F}\u{2070}-\u{218F}\u{2460}-\u{24FF}\u{2776}-\u{2793}\u{2C00}-\u{2DFF}\u{2E80}-\u{2FFF}\u{3004}-\u{3007}\u{3021}-\u{302F}\u{3031}-\u{303F}\u{3040}-\u{D7FF}\u{F900}-\u{FD3D}\u{FD40}-\u{FDCF}\u{FDF0}-\u{FE44}\u{FE47}-\u{FFFD}\u{10000}-\u{1FFFD}\u{20000}-\u{2FFFD}\u{30000}-\u{3FFFD}\u{40000}-\u{4FFFD}\u{50000}-\u{5FFFD}\u{60000}-\u{6FFFD}\u{70000}-\u{7FFFD}\u{80000}-\u{8FFFD}\u{90000}-\u{9FFFD}\u{A0000}-\u{AFFFD}\u{B0000}-\u{BFFFD}\u{C0000}-\u{CFFFD}\u{D0000}-\u{DFFFD}\u{E0000}-\u{EFFFD}]$/u;
const NON_INITIAL = /^[\u{0300}-\u{036F}\u{1DC0}-\u{1DFF}\u{20D0}-\u{20FF}\u{FE20}-\u{FE2F}]$/u;
const UNICODE_SPACE = /^[\u{0085}\u{00A0}\u{1680}\u{180E}\u{2000}-\u{200A}\u{2028}-\u{2029}\u{202F}\u{205F}\u{3000}]$/u;

export function isUnicodeIdentifier(char: string, initial: boolean): boolean {
  return C17_CHARACTER.test(char) && (!initial || !NON_INITIAL.test(char));
}

export function isUnicodeSpace(char: string): boolean {
  return UNICODE_SPACE.test(char);
}
