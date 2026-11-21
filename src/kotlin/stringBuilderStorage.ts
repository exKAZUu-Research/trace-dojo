interface Buffer {
  chars: string[];
  capacity: number;
  wide: boolean;
}

export class StringBuilderStorage {
  private buffer: Buffer;
  length = 0;

  constructor(capacity: number) {
    this.buffer = { chars: [], capacity, wide: false };
  }

  text(): string {
    return Array.from({ length: this.length }, (_, index) => this.character(index)).join('');
  }

  character(index: number): string {
    return this.buffer.chars[index] ?? '\0';
  }

  codeAt(index: number): number {
    return this.buffer.chars[index]?.codePointAt(0) ?? 0;
  }

  append(length: number, read: (index: number) => string): void {
    const count = this.length;
    const end = count + length;
    this.buffer = this.copyCharacters(this.reserve(end), count, length, read);
    this.length = end;
  }

  insert(position: number, length: number, read: (index: number) => string, count: number): void {
    const end = count + length;
    const buffer = this.reserve(end);
    this.shift(buffer, position + length, position, count);
    this.buffer = this.copyCharacters(buffer, position, length, read, end);
    this.length = end;
  }

  replace(from: number, to: number, inserted: string): void {
    const end = this.length - (to - from) + inserted.length;
    const buffer = this.reserve(end);
    this.shift(buffer, from + inserted.length, to, this.length);
    this.buffer = this.copyCharacters(buffer, from, inserted.length, (index) => inserted[index], end);
    this.length = end;
  }

  resize(length: number): void {
    if (length > this.length) {
      const buffer = this.reserve(length);
      buffer.chars.fill('\0', this.length, length);
      this.buffer = buffer;
    }
    this.length = length;
  }

  private reserve(length: number): Buffer {
    const { buffer } = this;
    const reserved =
      length <= buffer.capacity
        ? buffer
        : { ...buffer, capacity: Math.max(length, 2 * buffer.capacity + 2), chars: [...buffer.chars] };
    if (length > reserved.chars.length) reserved.chars.length = length;
    return reserved;
  }

  private shift(buffer: Buffer, to: number, from: number, end: number): void {
    if (to !== from) buffer.chars.copyWithin(to, from, end);
  }

  private copyCharacters(
    buffer: Buffer,
    start: number,
    length: number,
    read: (index: number) => string,
    inflatedLength?: number
  ): Buffer {
    // A callback can grow or recode the builder. Continue writing to the buffer captured before it ran.
    let target = buffer;
    for (let index = 0; index < length; index++) {
      const char = read(index);
      if (!target.wide && (char.codePointAt(0) ?? 0) > 255)
        target = { ...target, wide: true, chars: target.chars.slice(0, inflatedLength ?? start + index) };
      target.chars[start + index] = char;
    }
    return target;
  }
}
