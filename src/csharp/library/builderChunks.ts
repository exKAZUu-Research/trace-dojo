/**
 * The chunks of a .NET `StringBuilder`, whose sizes decide its `Capacity`: .NET keeps the text in a linked list of
 * character arrays and grows, splits, and drops them as `Append`, `Insert`, `Remove`, and `Length` change the text.
 * Only the offsets, sizes, and lengths are kept, transcribed from .NET's `StringBuilder`, since the text itself is
 * kept as one string.
 */
export class BuilderChunks {
  /** The chunks from the first to the last, which .NET's `StringBuilder` object itself is. */
  private chunks: Chunk[];

  /** One chunk holding the initial text, as large as the capacity asked for, or 16 for none. */
  constructor(capacity: number, length: number) {
    const size = Math.max(capacity === 0 ? DEFAULT_CAPACITY : capacity, length);
    this.chunks = [{ offset: 0, size, length }];
  }

  get capacity(): number {
    const last = this.last();
    return last.offset + last.size;
  }

  get length(): number {
    const last = this.last();
    return last.offset + last.length;
  }

  /** `Append` of `count` characters, which fills the last chunk and then adds one of at least the length so far. */
  append(count: number): void {
    const last = this.last();
    const room = last.size - last.length;
    if (count <= room) {
      last.length += count;
      return;
    }
    last.length = last.size;
    const rest = count - room;
    const size = Math.max(rest, Math.min(this.length, MAX_CHUNK_SIZE));
    this.chunks.push({ offset: this.length, size, length: rest });
  }

  /**
   * `Insert` of `count` characters at an index, which .NET's `MakeRoom` fits in place or in a new chunk before; `Replace`
   * always adds the chunk, keeping the characters after the index where they are.
   */
  insert(index: number, count: number, canMoveFollowing = true): void {
    if (count === 0) return;
    let position = this.chunks.length - 1;
    while (this.chunks[position].offset > index) {
      this.chunks[position].offset += count;
      position--;
    }
    const chunk = this.chunks[position];
    if (canMoveFollowing && chunk.length <= DEFAULT_CAPACITY * 2 && chunk.size - chunk.length >= count) {
      chunk.length += count;
      return;
    }
    const added: Chunk = { offset: chunk.offset, size: Math.max(count, DEFAULT_CAPACITY), length: count };
    chunk.offset += count;
    this.chunks.splice(position, 0, added);
  }

  /** `Remove` of `count` characters from an index, which drops the chunks wholly inside the range. */
  // code-gauge-allow functionNcss -- Each branch follows .NET's StringBuilder.Remove, transcribed to keep its capacity.
  // code-gauge-allow functionCognitiveComplexity -- Each branch follows .NET's StringBuilder.Remove, transcribed to keep its capacity.
  remove(start: number, count: number): void {
    if (start === 0 && count === this.length) {
      this.setLength(0);
      return;
    }
    if (count <= 0) return;
    const end = start + count;
    let position = this.chunks.length - 1;
    let endPosition: number | undefined;
    let endInChunk = 0;
    let startInChunk = 0;
    for (;;) {
      const chunk = this.chunks[position];
      if (end - chunk.offset >= 0) {
        if (endPosition === undefined) {
          endPosition = position;
          endInChunk = end - chunk.offset;
        }
        if (start - chunk.offset >= 0) {
          startInChunk = start - chunk.offset;
          break;
        }
      } else {
        chunk.offset -= count;
      }
      position--;
    }
    const startChunk = this.chunks[position];
    const endChunk = this.chunks[endPosition];
    let targetInChunk = startInChunk;
    if (endChunk !== startChunk) {
      targetInChunk = 0;
      startChunk.length = startInChunk;
      endChunk.offset = startChunk.offset + startChunk.length;
      // The chunks between the two go, and the first one too when the range starts it.
      const kept = startInChunk === 0 ? position : position + 1;
      this.chunks.splice(kept, endPosition - kept);
    }
    endChunk.length -= endInChunk - targetInChunk;
  }

  /**
   * `Replace(oldValue, newValue, start, count)` on a text, returning the new text: .NET finds the occurrences chunk by
   * chunk, and for each chunk's occurrences adds a chunk for the growth or removes what they shrink by.
   */
  // code-gauge-allow functionCognitiveComplexity -- The scan follows .NET's chunk by chunk, sharing its position, remaining count, and pending replacements.
  // code-gauge-allow functionNcss -- The scan follows .NET's chunk by chunk, sharing its position, remaining count, and pending replacements.
  replace(
    text: string,
    oldValue: string,
    newValue: string,
    start: number,
    count: number,
    /** Charges work in characters: the text the search reads, each chunk's rebuild, and each chunk lookup. */
    charge: (work: number) => void
  ): string {
    let current = text;
    let remaining = count;
    let chunk = this.chunkAt(start);
    let indexInChunk = start - chunk.offset;
    let replacements: number[] = [];
    // The next occurrence at or after the scanned position, found once for the text so far: a host search reads the
    // text in linear time, while comparing at each position reads a long common prefix again and again.
    let next: number | undefined;
    while (remaining > 0) {
      const position = chunk.offset + indexInChunk;
      if (next === undefined || (next !== -1 && next < position)) {
        // The search reads only the range left, as text past it holds no occurrence the call replaces.
        const end = position + remaining;
        const found = current.slice(position, end).indexOf(oldValue);
        next = found === -1 ? -1 : position + found;
        charge((found === -1 ? end - position : found + oldValue.length) + 1);
      }
      const isMatch =
        next !== -1 && next < chunk.offset + chunk.length && next + oldValue.length <= position + remaining;
      if (isMatch) {
        replacements.push(next - chunk.offset);
        indexInChunk = next - chunk.offset + oldValue.length;
        remaining -= next - position + oldValue.length;
      } else {
        const skipped = Math.min(chunk.length - indexInChunk, remaining);
        indexInChunk += skipped;
        remaining -= skipped;
      }
      if (indexInChunk >= chunk.length || remaining === 0) {
        let index = chunk.offset + indexInChunk;
        if (replacements.length > 0) {
          charge(current.length);
          current = this.replaceInChunk(current, replacements, chunk.offset, oldValue, newValue);
          index += (newValue.length - oldValue.length) * replacements.length;
          replacements = [];
          next = undefined;
        }
        charge(this.chunks.length);
        chunk = this.chunkAt(index);
        indexInChunk = index - chunk.offset;
      }
    }
    return current;
  }

  /** .NET's `ReplaceAllInChunk`, for the occurrences at offsets of a chunk that starts at a logical index. */
  private replaceInChunk(
    text: string,
    replacements: number[],
    chunkOffset: number,
    oldValue: string,
    newValue: string
  ): string {
    const delta = (newValue.length - oldValue.length) * replacements.length;
    if (delta > 0) this.insert(chunkOffset + replacements[0], delta, false);
    // One pass over the text, since slicing it anew for each occurrence takes quadratic time.
    const parts: string[] = [];
    let copied = 0;
    for (const replacement of replacements) {
      const index = chunkOffset + replacement;
      parts.push(text.slice(copied, index), newValue);
      copied = index + oldValue.length;
    }
    parts.push(text.slice(copied));
    const result = parts.join('');
    if (delta < 0) this.remove(chunkOffset + (replacements.at(-1) as number) + oldValue.length + delta, -delta);
    return result;
  }

  /** The chunk holding a logical index, as .NET's `FindChunkForIndex` finds it. */
  private chunkAt(index: number): Chunk {
    let position = this.chunks.length - 1;
    while (this.chunks[position].offset > index) position--;
    return this.chunks[position];
  }

  /** The `Length` setter, which pads with `Append` or cuts back to the chunk holding the new end. */
  setLength(length: number): void {
    const delta = length - this.length;
    if (delta > 0) {
      this.append(delta);
      return;
    }
    if (length === 0 && this.chunks.length === 1) {
      this.chunks[0].length = 0;
      return;
    }
    let position = this.chunks.length - 1;
    while (this.chunks[position].offset > length) position--;
    const chunk = this.chunks[position];
    const last = this.last();
    if (chunk !== last) {
      // .NET keeps a little more than the text as the capacity of the chunk that becomes the last one.
      const preserved = Math.min(this.capacity, Math.max(Math.trunc((this.length * 6) / 5), last.size));
      chunk.size = Math.max(preserved - chunk.offset, chunk.size);
      this.chunks.splice(position + 1);
    }
    chunk.length = length - chunk.offset;
  }

  /** The `Capacity` setter, which resizes the last chunk. */
  setCapacity(capacity: number): void {
    const last = this.last();
    last.size = capacity - last.offset;
  }

  private last(): Chunk {
    return this.chunks.at(-1) as Chunk;
  }
}

interface Chunk {
  offset: number;
  size: number;
  length: number;
}

const DEFAULT_CAPACITY = 16;
const MAX_CHUNK_SIZE = 8000;
