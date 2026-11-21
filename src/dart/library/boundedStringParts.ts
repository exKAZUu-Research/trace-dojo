import { LIMITS } from '../../interpreter/limits';
import type { Runtime } from '../runtime';

export class BoundedStringParts {
  private readonly parts = new StringParts();
  private length = 0;

  constructor(private readonly runtime: Runtime) {}

  append(part: string): void {
    if (part.length === 0) return;
    this.length += part.length;
    if (this.length > LIMITS.maxStringLength) this.runtime.throwError('OutOfMemoryError', '', []);
    this.runtime.spend(Math.ceil(part.length / 1024));
    this.parts.append(part);
  }

  appendEscaped(text: string, asciiCharacters: RegExp, escape: (character: string) => string): void {
    for (let start = 0; start < text.length; start += 1024) {
      this.runtime.spend();
      this.append(text.slice(start, start + 1024).replaceAll(asciiCharacters, escape));
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
