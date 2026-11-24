/** The pieces an expansion makes, and Bash's field splitting of them. */

/** Text from an expansion: whether quotes protect it from splitting and patterns, and whether it may be split. */
export interface Fragment {
  text: string;
  quoted: boolean;
  /** Whether the text came from an unquoted expansion, which field splitting splits at `IFS` characters. */
  split: boolean;
  /** Whether the fragment came from an element of an unquoted `@`-list (`$@` or `${a[@]}`). */
  atListElement?: boolean;
  /** Whether an empty `@`-list fragment was selected by an unquoted `${x:-word}` / `${x:+word}` operator. */
  operatorNull?: boolean;
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
  private field: Fragment[] = [];
  private started = false;
  private afterWhite = false;
  private afterListWhite = false;
  private afterDelimiter = false;
  private readonly hasNonWhitePrimaryIfs: boolean;

  constructor(private readonly ifs: string) {
    this.hasNonWhitePrimaryIfs = ifs !== '' && ifs[0] !== ' ' && ifs[0] !== '\t' && ifs[0] !== '\n';
  }

  add(piece: Piece): void {
    if (piece === EMPTY_LIST) return;
    if (isFieldBreak(piece)) {
      this.onFieldBreak();
    } else if (!piece.split || this.ifs === '') {
      if (piece.text === '' && !piece.quoted) return;
      this.field.push({ ...piece, split: false });
      this.started = true;
      this.afterWhite = false;
      this.afterListWhite = false;
      this.afterDelimiter = false;
    } else if (piece.text !== '') {
      this.split(piece.text);
    } else if (piece.operatorNull && this.ifs !== '' && this.ifs[0] !== ' ') {
      this.started = true;
      this.afterWhite = false;
      this.afterListWhite = false;
      this.afterDelimiter = false;
    }
  }

  private onFieldBreak(): void {
    if (this.ifs === '') {
      if (this.started) this.end();
      return;
    }
    if (this.afterListWhite) {
      this.afterWhite = true;
      this.afterListWhite = false;
    }
    if (this.hasNonWhitePrimaryIfs) {
      this.separate(this.ifs[0]);
      return;
    }
    if (this.started) {
      this.end();
      this.afterWhite = true;
    } else if (!this.afterDelimiter) {
      this.afterWhite = true;
    }
  }

  finish(): Fragment[][] {
    if (this.started) this.end();
    return this.fields;
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
        this.afterListWhite = false;
        this.afterDelimiter = false;
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
      if (this.started) {
        this.end();
        this.afterWhite = true;
      } else if (!this.afterDelimiter) {
        this.afterListWhite = true;
      }
      return;
    }
    if (this.started) this.end();
    else if (!this.afterWhite) this.fields.push([]);
    this.afterWhite = false;
    this.afterListWhite = false;
    this.afterDelimiter = true;
  }
}
