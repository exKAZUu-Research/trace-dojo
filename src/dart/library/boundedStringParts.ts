import { LIMITS } from '../../interpreter/limits';
import { encodableText } from '../format';
import type { Runtime } from '../runtime';

export function stringSlice(runtime: Runtime, text: string, start: number, end = text.length): string {
  return detachShorterString(runtime, text, text.slice(start, end));
}

export function detachShorterString(runtime: Runtime, source: string, text: string): string {
  return text.length < source.length ? copyString(runtime, text) : text;
}

export function copyString(runtime: Runtime, text: string): string {
  if (text.length === 0) return text;
  runtime.spendString(text.length);
  // V8 may retain a slice's backing string even when the slice is small.
  return Buffer.from(text, 'utf16le').toString('utf16le');
}

export class BoundedStringParts {
  private readonly parts = new StringParts();
  private size = 0;

  constructor(private readonly runtime: Runtime) {}

  get length(): number {
    return this.size;
  }

  append(part: string): void {
    if (part.length === 0) return;
    const size = this.size + part.length;
    if (size > LIMITS.maxStringLength) this.runtime.throwError('OutOfMemoryError', '', []);
    this.runtime.spendString(part.length);
    this.parts.append(part);
    this.size = size;
  }

  appendEscaped(text: string, asciiCharacters: RegExp, escape: (character: string) => string): void {
    for (let start = 0; start < text.length; start += 1024) {
      this.runtime.spend();
      this.append(text.slice(start, start + 1024).replaceAll(asciiCharacters, escape));
    }
  }

  appendVmCString(text: string): void {
    const zero = text.indexOf('\0');
    const end = zero === -1 ? text.length : zero;
    for (let start = 0; start < end;) {
      let next = Math.min(start + 1024, end);
      if (next < end && (text.codePointAt(next - 1) ?? 0) > 0xff_ff) next++;
      this.append(encodableText(text.slice(start, next)));
      start = next;
    }
  }

  text(): string {
    return this.parts.text();
  }
}

export function appendJsonQuoted(text: string, append: (part: string) => void): void {
  append('"');
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 1024, text.length);
    if ((text.codePointAt(end - 1) ?? 0) > 0xff_ff) end++;
    append(JSON.stringify(text.slice(start, end)).slice(1, -1));
    start = end;
  }
  append('"');
}

export class StringParts {
  private readonly chunks: string[] = [];
  private readonly fragments: string[] = [];

  append(fragment: string): void {
    if (fragment.length === 0) return;
    this.fragments.push(fragment);
    if (this.fragments.length === 128) {
      this.chunks.push(this.fragments.join(''));
      this.fragments.length = 0;
    }
  }

  text(): string {
    return this.chunks.join('') + this.fragments.join('');
  }
}
