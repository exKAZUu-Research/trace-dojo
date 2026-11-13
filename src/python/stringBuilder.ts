import { currentRuntime } from './runtimeContext';

/** `text` repeated `count` times, refused and charged before the host builds it. */
export function repeatText(text: string, count: number): string {
  if (count <= 0 || text === '') return '';
  currentRuntime().buildString(text.length * count);
  return text.repeat(count);
}

/**
 * Collects the pieces of a string whose length the program decides, refusing a piece that would take it beyond the
 * length limit before appending it, and charging for the whole text once.
 */
export class StringBuilder {
  private text = '';

  append(piece: string): this {
    currentRuntime().ensureStringFits(this.text.length + piece.length);
    this.text += piece;
    return this;
  }

  appendRepeated(piece: string, count: number): this {
    if (count <= 0) return this;
    currentRuntime().ensureStringFits(this.text.length + piece.length * count);
    this.text += piece.repeat(count);
    return this;
  }

  build(): string {
    currentRuntime().spend(Math.ceil(this.text.length / 16));
    return this.text;
  }
}
