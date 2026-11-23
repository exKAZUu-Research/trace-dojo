// Kotlin/JVM's `Char` predicates and simple case mappings follow `java.lang.Character`, approximated here with the
// host's Unicode data, whose version may differ from the JDK's.

const LETTER = /^\p{L}$/u;
const DIGIT = /^\p{Nd}$/u;
const UNASSIGNED = /^\p{Cn}$/u;
const UPPERCASE = /^\p{Uppercase}$/u;
const LOWERCASE = /^\p{Lowercase}$/u;
const TITLECASE = /^\p{Lt}$/u;

export function isJdkDefined(code: number): boolean {
  return !UNASSIGNED.test(String.fromCodePoint(code));
}

export function isJdkLetter(code: number): boolean {
  return LETTER.test(String.fromCodePoint(code));
}

export function isJdkDigit(code: number): boolean {
  return DIGIT.test(String.fromCodePoint(code));
}

export function isJdkLetterOrDigit(code: number): boolean {
  return isJdkLetter(code) || isJdkDigit(code);
}

export function isJdkUpperCase(code: number): boolean {
  return UPPERCASE.test(String.fromCodePoint(code));
}

export function isJdkLowerCase(code: number): boolean {
  return LOWERCASE.test(String.fromCodePoint(code));
}

/** `Character.toUpperCase`, which keeps a character whose only uppercase form has several characters, such as `ß`. */
export function upperJdkChar(code: number): number {
  return simpleMapping(code, String.fromCodePoint(code).toUpperCase());
}

/** `Character.toLowerCase`, which maps `İ` to the `i` that its full lowercase form `i̇` starts with. */
export function lowerJdkChar(code: number): number {
  const lower = String.fromCodePoint(code).toLowerCase();
  return simpleMapping(code, BASE_WITH_MARKS.exec(lower)?.[1] ?? lower);
}

const BASE_WITH_MARKS = /^(\P{M})\p{M}+$/u;

function simpleMapping(code: number, mapped: string): number {
  const codePoint = mapped.codePointAt(0) as number;
  // A mapping that changes the UTF-16 width would not fit a Kotlin `Char`.
  return mapped.length === String.fromCodePoint(code).length && String.fromCodePoint(codePoint) === mapped
    ? codePoint
    : code;
}

/** `Character.toTitleCase`: the titlecase letter of a digraph such as `ǆ`, and the uppercase form otherwise. */
export function titleJdkChar(code: number): number {
  if (TITLECASE.test(String.fromCodePoint(code))) return code;
  const upper = upperJdkChar(code);
  const digraph = upper + 1;
  return TITLECASE.test(String.fromCodePoint(digraph)) && lowerJdkChar(digraph) === lowerJdkChar(code)
    ? digraph
    : upper;
}

/** Kotlin/JVM's `Char.titlecase()`. */
export function titleJdkText(code: number): string {
  // Kotlin's Char holds one UTF-16 code unit, including an unpaired surrogate.
  const upper = String.fromCodePoint(code).toUpperCase();
  if (upper.length <= 1) return String.fromCodePoint(titleJdkChar(code));
  return code === 0x1_49 ? upper : upper[0] + upper.slice(1).toLowerCase();
}

/** `Character.toLowerCase(Character.toUpperCase(codePoint))`, which the JDK's case-insensitive comparisons compare. */
export function foldJdkCodePoint(codePoint: number): number {
  return lowerJdkChar(upperJdkChar(codePoint));
}

export function foldJdkText(value: string, supplementary: boolean): string {
  const positions = supplementary ? /[A-Z\u0080-\u{10FFFF}]/gu : /[A-Z\u0080-￿]/g;
  return value.replace(positions, (char) => String.fromCodePoint(foldJdkCodePoint(char.codePointAt(0) as number)));
}

export function compareJdkCase(left: string, right: string): number {
  const nonLatin1 = /[Ā-￿]/;
  const supplementary = nonLatin1.test(left) && nonLatin1.test(right);
  const a = foldJdkText(left, supplementary);
  const b = foldJdkText(right, supplementary);
  const limit = Math.min(a.length, b.length);
  for (let index = 0; index < limit;) {
    const first = codeAt(a, index, supplementary);
    const second = codeAt(b, index, supplementary);
    if (first !== second) return first - second;
    index += first > 0xff_ff ? 2 : 1;
  }
  return a.length - b.length;
}

function codeAt(value: string, index: number, supplementary: boolean): number {
  // oxlint-disable-next-line unicorn/prefer-code-point -- The JDK's Latin-1 comparison reads UTF-16 code units.
  return supplementary ? (value.codePointAt(index) as number) : value.charCodeAt(index);
}
