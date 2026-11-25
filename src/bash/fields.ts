/** Immutable per-word context and typed segment model for Bash word expansion and pure field splitting. */

export interface WordContext {
  readonly inDouble: boolean;
  readonly spacedStar: boolean;
  readonly spacedArrayStar?: boolean;
  readonly splittingFields?: boolean;
  readonly inAssignmentValue?: boolean;
  readonly inAssignmentRhs?: boolean;
  readonly inOperatorWord?: boolean;
  readonly inQuotedOperatorWord?: boolean;
  readonly inSubscript?: boolean;
}

export const DEFAULT_WORD_CONTEXT: WordContext = { inDouble: false, spacedStar: false };
export const FIELD_SPLITTING_WORD_CONTEXT: WordContext = { inDouble: false, spacedStar: false, splittingFields: true };

export interface TextSegment {
  readonly kind: 'text';
  readonly text: string;
  readonly quoted: boolean;
  readonly split: boolean;
  readonly fromList?: boolean;
}

export interface BreakSegment {
  readonly kind: 'break';
  readonly breakKind: 'field' | 'positional' | 'star';
  readonly ifsJoiner?: string;
  readonly quoted?: boolean;
}

export interface EmptyListSegment {
  readonly kind: 'emptyList';
}

export type WordSegment = TextSegment | BreakSegment | EmptyListSegment;

export const EMPTY_LIST_SEGMENT: EmptyListSegment = { kind: 'emptyList' };
export const QUOTED_EMPTY_SEGMENT: TextSegment = { kind: 'text', text: '', quoted: true, split: false };

export function breakSegment(breakKind: BreakSegment['breakKind'], ifsJoiner?: string, quoted?: boolean): BreakSegment {
  return {
    kind: 'break',
    breakKind,
    ...(ifsJoiner === undefined ? {} : { ifsJoiner }),
    ...(quoted ? { quoted: true } : {}),
  };
}

export function textSegment(text: string, quoted: boolean, split: boolean, fromList?: boolean): TextSegment {
  return fromList ? { kind: 'text', text, quoted, split, fromList: true } : { kind: 'text', text, quoted, split };
}

export function isBreakSegment(segment: WordSegment): segment is BreakSegment {
  return segment.kind === 'break';
}

/**
 * Pure Bash field-splitting function with fresh per-call state: a run of `IFS` whitespace separates fields,
 * and each non-whitespace `IFS` character terminates a field (adjacent whitespace coalesces with one delimiter).
 */
export function splitWordSegments(segments: readonly WordSegment[], ifs: string): TextSegment[][] {
  const hasList = segments.some((seg) => seg.kind === 'break' || seg.kind === 'emptyList' || Boolean(seg.fromList));
  const state = new SplitterState(ifs, hasList);
  for (const segment of segments) state.add(segment);
  return state.finish();
}

class SplitterState {
  private readonly fields: TextSegment[][] = [];
  private field: TextSegment[] = [];
  private started = false;
  private afterWhite = false;
  private afterDelimiter = false;
  private readonly hasNonWhitePrimaryIfs: boolean;

  constructor(
    private readonly ifs: string,
    private readonly hasList: boolean
  ) {
    this.hasNonWhitePrimaryIfs = ifs !== '' && ifs[0] !== ' ' && ifs[0] !== '\t' && ifs[0] !== '\n';
  }

  add(segment: WordSegment): void {
    if (segment.kind === 'emptyList') return;
    if (segment.kind === 'break') {
      this.onFieldBreak(segment);
    } else if (!segment.split || this.ifs === '') {
      if (segment.text === '' && !segment.quoted) return;
      this.field.push({ ...segment, split: false });
      this.started = true;
      this.afterWhite = false;
      this.afterDelimiter = false;
    } else if (segment.text !== '') {
      this.splitText(segment.text);
    }
  }

  finish(): TextSegment[][] {
    if (this.started) this.end();
    return this.fields;
  }

  private onFieldBreak(segment: BreakSegment): void {
    if (segment.quoted) {
      if (this.started) this.end();
      this.afterWhite = true;
      this.afterDelimiter = false;
      return;
    }
    if (this.ifs === '') {
      if (this.started) this.end();
      return;
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

  private end(): void {
    this.fields.push(this.field);
    this.field = [];
    this.started = false;
  }

  private splitText(text: string): void {
    let run = '';
    for (const c of text) {
      if (!this.ifs.includes(c)) {
        run += c;
        this.started = true;
        this.afterWhite = false;
        this.afterDelimiter = false;
        continue;
      }
      if (run) this.field.push(textSegment(run, false, false));
      run = '';
      this.separate(c);
    }
    if (run) this.field.push(textSegment(run, false, false));
  }

  private separate(c: string): void {
    if (c === ' ' || c === '\t' || c === '\n') {
      if (this.started) {
        this.end();
        this.afterWhite = true;
      } else if (!this.afterDelimiter && this.hasList) {
        this.afterWhite = true;
      }
      return;
    }
    if (this.started) this.end();
    else if (!this.afterWhite) this.fields.push([]);
    this.afterWhite = false;
    this.afterDelimiter = true;
  }
}
