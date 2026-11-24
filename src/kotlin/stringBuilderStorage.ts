interface BuilderPosition {
  length: number;
  wide: boolean;
}

export class StringBuilderStorage {
  private bytes: Uint8Array;
  private wide = false;
  private maybeLatin1 = false;
  length = 0;

  constructor(capacity: number) {
    this.bytes = new Uint8Array(capacity);
  }

  text(from = 0, to = this.length): string {
    return Array.from({ length: to - from }, (_, index) => String.fromCodePoint(this.codeAt(from + index))).join('');
  }

  codeAt(index: number): number {
    if (!this.wide) return this.bytes[index] ?? 0;
    return (this.bytes[2 * index] ?? 0) | ((this.bytes[2 * index + 1] ?? 0) << 8);
  }

  get readableLength(): number {
    return Math.min(this.length, this.bytes.length >> Number(this.wide));
  }

  get compactionLimit(): number | undefined {
    const readable = this.readableLength;
    return this.wide && this.maybeLatin1 && this.length > readable ? readable : undefined;
  }

  markPossiblyLatin1(): void {
    this.maybeLatin1 = true;
  }

  setCharAt(index: number, value: string): void {
    this.replace(index, index + 1, value);
    if (this.wide) this.markPossiblyLatin1();
  }

  position(): BuilderPosition {
    return { length: this.length, wide: this.wide };
  }

  appendText(text: string): void {
    this.append(text.length, (index) => codeUnit(text, index));
  }

  appendBuilder(source: StringBuilderStorage, fail: (required: number, available: number) => never): void {
    const end = this.length + source.length;
    if (!this.wide && source.wide) {
      const capacity = this.bytes.length;
      const bytes = new Uint8Array(2 * (end <= capacity ? capacity : Math.max(end, capacity + 2)));
      for (let index = 0; index < this.length; index++) bytes[2 * index] = this.bytes[index];
      this.bytes = bytes;
      this.wide = true;
    } else {
      this.bytes = this.reserve(end, this.wide);
    }
    const required = source.length << Number(source.wide);
    if (required > source.bytes.length) fail(required, source.bytes.length);
    if (this.wide === source.wide) {
      this.bytes.set(source.bytes.subarray(0, required), this.length << Number(this.wide));
    } else {
      for (let index = 0; index < source.length; index++) {
        const offset = 2 * (this.length + index);
        this.bytes[offset] = source.bytes[index];
        this.bytes[offset + 1] = 0;
      }
    }
    this.length = end;
    this.maybeLatin1 ||= source.maybeLatin1;
  }

  append(length: number, read: (index: number) => number): void {
    const { length: count, wide } = this.position();
    const end = count + length;
    const bytes = this.reserve(end, wide);
    this.commit(bytes, copyCharacters(bytes, wide, count, length, read), end);
  }

  insert(position: number, length: number, read: (index: number) => number, previous: BuilderPosition): void {
    const { length: count, wide } = previous;
    const end = count + length;
    const bytes = this.reserve(end, wide);
    shift(bytes, wide, position + length, position, count);
    this.commit(bytes, copyCharacters(bytes, wide, position, length, read, end), end);
  }

  replace(from: number, to: number, inserted: string): void {
    const { length: count, wide } = this.position();
    const end = count - (to - from) + inserted.length;
    const bytes = this.reserve(end, wide);
    shift(bytes, wide, from + inserted.length, to, count);
    const result = copyCharacters(bytes, wide, from, inserted.length, (index) => codeUnit(inserted, index), end);
    this.commit(bytes, result, end);
  }

  resize(length: number): void {
    this.bytes = this.reserve(length, this.wide);
    if (length > this.length) {
      const width = this.wide ? 2 : 1;
      this.bytes.fill(0, this.length * width, length * width);
    } else if (length < this.length) {
      this.markPossiblyLatin1();
    }
    this.length = length;
  }

  private reserve(length: number, wide: boolean): Uint8Array {
    const width = wide ? 2 : 1;
    if (length * width <= this.bytes.length) return this.bytes;
    const capacity = Math.floor(this.bytes.length / width);
    const grown = new Uint8Array(width * Math.max(length, 2 * capacity + 2));
    grown.set(this.bytes);
    return grown;
  }

  private commit(original: Uint8Array, edited: Uint8Array, length: number): void {
    // A source callback can change the coder. Committing the earlier byte array does not reset that field.
    if (original !== edited) this.wide = true;
    this.bytes = edited;
    this.length = length;
  }
}

function shift(bytes: Uint8Array, wide: boolean, to: number, from: number, end: number): void {
  const width = wide ? 2 : 1;
  bytes.copyWithin(to * width, from * width, end * width);
}

function copyCharacters(
  bytes: Uint8Array,
  wide: boolean,
  start: number,
  length: number,
  read: (index: number) => number,
  inflatedLength?: number
): Uint8Array {
  let target = bytes;
  let isWide = wide;
  for (let index = 0; index < length; index++) {
    const code = read(index);
    const position = start + index;
    if (!isWide && code > 255) {
      target = inflate(target, inflatedLength ?? position);
      isWide = true;
    }
    if (isWide) {
      target[2 * position] = code & 255;
      target[2 * position + 1] = code >>> 8;
    } else {
      target[position] = code;
    }
  }
  return target;
}

function inflate(bytes: Uint8Array, length: number): Uint8Array {
  const widened = new Uint8Array(bytes.length * 2);
  for (let index = 0; index < length; index++) widened[2 * index] = bytes[index];
  return widened;
}

function codeUnit(text: string, index: number): number {
  // oxlint-disable-next-line unicorn/prefer-code-point -- StringBuilder storage is indexed in UTF-16 code units.
  return text.charCodeAt(index);
}
