/** The pieces an expansion makes, and Bash's field splitting of them. */

/** Text from an expansion: whether quotes protect it from splitting and patterns, and whether it may be split. */
export interface Fragment {
  text: string;
  quoted: boolean;
  /** Whether the text came from an unquoted expansion, which field splitting splits at `IFS` characters. */
  split: boolean;
}

/** Separates the fields of `"$@"` and `"${a[@]}"`. */
export const FIELD_BREAK = Symbol('fieldBreak');
/**
 * Separates the elements of an unquoted `$*` or `${a[*]}`, which split as `FIELD_BREAK` does, but which an expansion
 * that is not split joins with the first character of `IFS`, as `"$*"` does.
 */
export const STAR_BREAK = Symbol('starBreak');
/** Marks an `@`-subscripted expansion inside double quotes that produced zero elements, so `"${a[@]}"` vanishes. */
export const EMPTY_LIST = Symbol('emptyList');
export type Piece = Fragment | typeof FIELD_BREAK | typeof STAR_BREAK | typeof EMPTY_LIST;

export function isFieldBreak(piece: Piece): piece is typeof FIELD_BREAK | typeof STAR_BREAK {
  return piece === FIELD_BREAK || piece === STAR_BREAK;
}

/**
 * Bash's field splitting: a run of `IFS` whitespace separates fields, and each other `IFS` character ends one, so two
 * of them in a row make an empty field, though one next to whitespace counts as one separator with it.
 */
export class FieldSplitter {
  private readonly fields: Fragment[][] = [];
  private readonly segment: Fragment[] = [];
  private field: Fragment[] = [];
  private started = false;
  private afterWhite = false;

  constructor(private readonly ifs: string) {}

  add(piece: Piece): void {
    if (piece === EMPTY_LIST) return;
    if (isFieldBreak(piece)) {
      this.flushSegment();
      return;
    }
    if (piece.text === '' && !piece.quoted) return;
    this.segment.push(piece);
  }

  finish(): Fragment[][] {
    this.flushSegment();
    return this.fields;
  }

  private flushSegment(): void {
    if (this.segment.length === 0) return;
    const pieces = this.segment.splice(0);
    if (!pieces.some((piece) => piece.text.length > 0)) {
      this.fields.push([{ text: '', quoted: true, split: false }]);
      return;
    }
    this.started = false;
    this.afterWhite = false;
    for (const piece of pieces) {
      if (piece.text === '') continue;
      if (!piece.split || this.ifs === '') {
        this.field.push({ ...piece, split: false });
        this.started = true;
        this.afterWhite = false;
      } else {
        this.split(piece.text);
      }
    }
    if (this.started) this.end();
  }

  private end(): void {
    this.fields.push(this.field);
    this.field = [];
    this.started = false;
  }

  private split(text: string): void {
    let run = '';
    for (const c of text) {
      if (!this.ifs.includes(c)) {
        run += c;
        this.started = true;
        this.afterWhite = false;
        continue;
      }
      if (run) this.field.push({ text: run, quoted: false, split: false });
      run = '';
      this.separate(c);
    }
    if (run) this.field.push({ text: run, quoted: false, split: false });
  }

  private separate(c: string): void {
    if (c === ' ' || c === '\t' || c === '\n') {
      if (!this.started) return;
      this.end();
      this.afterWhite = true;
      return;
    }
    if (this.started) this.end();
    else if (!this.afterWhite) this.fields.push([]);
    this.afterWhite = false;
  }
}
