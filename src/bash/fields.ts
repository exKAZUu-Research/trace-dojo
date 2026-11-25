/** Immutable per-word context and typed segment model for Bash word expansion and pure field splitting. */

export interface WordContext {
  readonly inDouble: boolean;
  readonly spacedStar: boolean;
  readonly inAssignmentValue?: boolean;
  readonly inOperatorWord?: boolean;
}

export const DEFAULT_WORD_CONTEXT: WordContext = { inDouble: false, spacedStar: false };

export interface TextSegment {
  readonly kind: 'text';
  readonly text: string;
  readonly quoted: boolean;
  readonly split: boolean;
  readonly atListElement?: boolean;
  readonly operatorNull?: boolean;
  readonly fromList?: boolean;
}

export interface BreakSegment {
  readonly kind: 'break';
  readonly breakKind: 'field' | 'positional' | 'star';
  readonly ifsJoiner?: string;
}

export interface EmptyListSegment {
  readonly kind: 'emptyList';
}

export type WordSegment = TextSegment | BreakSegment | EmptyListSegment;

export const EMPTY_LIST_SEGMENT: EmptyListSegment = { kind: 'emptyList' };
export const QUOTED_EMPTY_SEGMENT: TextSegment = { kind: 'text', text: '', quoted: true, split: false };

export function breakSegment(breakKind: BreakSegment['breakKind'], ifsJoiner?: string): BreakSegment {
  return ifsJoiner === undefined ? { kind: 'break', breakKind } : { kind: 'break', breakKind, ifsJoiner };
}

export function textSegment(
  text: string,
  quoted: boolean,
  split: boolean,
  extra?: { atListElement?: boolean; operatorNull?: boolean; fromList?: boolean }
): TextSegment {
  return { kind: 'text', text, quoted, split, ...extra };
}

export function isBreakSegment(segment: WordSegment): segment is BreakSegment {
  return segment.kind === 'break';
}

/**
 * Pure Bash field-splitting function with fresh per-call state: a run of `IFS` whitespace separates fields,
 * and each non-whitespace `IFS` character terminates a field (adjacent whitespace coalesces with one delimiter).
 */
export function splitWordSegments(segments: readonly WordSegment[], ifs: string): TextSegment[][] {
  const state = new SplitterState(ifs);
  for (const segment of segments) state.add(segment);
  return state.finish();
}

class SplitterState {
  private readonly fields: TextSegment[][] = [];
  private field: TextSegment[] = [];
  private started = false;
  private afterWhite = false;
  private afterListWhite = false;
  private afterDelimiter = false;
  private readonly hasNonWhitePrimaryIfs: boolean;

  constructor(private readonly ifs: string) {
    this.hasNonWhitePrimaryIfs = ifs !== '' && ifs[0] !== ' ' && ifs[0] !== '\t' && ifs[0] !== '\n';
  }

  add(segment: WordSegment): void {
    if (segment.kind === 'emptyList') return;
    if (segment.kind === 'break') {
      this.onFieldBreak();
    } else if (!segment.split || this.ifs === '') {
      if (segment.text === '' && !segment.quoted) return;
      this.field.push({ ...segment, split: false });
      this.started = true;
      this.afterWhite = false;
      this.afterListWhite = false;
      this.afterDelimiter = false;
    } else if (segment.text !== '') {
      this.splitText(segment.text, Boolean(segment.fromList));
    } else if (segment.operatorNull && this.ifs !== '' && this.ifs[0] !== ' ') {
      this.started = true;
      this.afterWhite = false;
      this.afterListWhite = false;
      this.afterDelimiter = false;
    }
  }

  finish(): TextSegment[][] {
    if (this.started) this.end();
    return this.fields;
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

  private end(): void {
    this.fields.push(this.field);
    this.field = [];
    this.started = false;
  }

  private splitText(text: string, fromList: boolean): void {
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
      if (run) this.field.push(textSegment(run, false, false));
      run = '';
      this.separate(c, fromList);
    }
    if (run) this.field.push(textSegment(run, false, false));
  }

  private separate(c: string, fromList = false): void {
    if (c === ' ' || c === '\t' || c === '\n') {
      if (this.started) {
        this.end();
        this.afterWhite = true;
      } else if (!this.afterDelimiter) {
        if (fromList) this.afterWhite = true;
        else this.afterListWhite = true;
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
