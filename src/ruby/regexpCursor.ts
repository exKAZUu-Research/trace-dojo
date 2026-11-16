import { rubyError } from './errors';
import { execAt, matchSnapshot, type MatchState, validateRegexpSubject } from './libRegexp';
import type { RObject, RString } from './objects';
import { charIndex, regexpByteIndex, regexpByteUnit } from './regexpPositions';
import { rt } from './runtime';
import { stringBytes, stringFromBytes } from './values';

export class RegexpCursor {
  readonly initial: RString;
  readonly length: number;
  snapshot: RString;
  private bytes: Uint8Array;
  private readonly initialBytes: Uint8Array;

  constructor(
    private readonly regexp: RObject,
    private readonly subject: RString
  ) {
    this.snapshot = matchSnapshot(subject);
    this.initial = this.snapshot;
    this.bytes = stringBytes(this.snapshot);
    this.initialBytes = this.bytes;
    this.length = this.bytes.length;
    validateRegexpSubject(regexp, subject);
  }

  match(byte: number): MatchState | undefined {
    if (byte > this.length) return undefined;
    const start = charIndex(this.snapshot.s, regexpByteUnit(this.snapshot, byte));
    return execAt(this.regexp, this.snapshot.s, start, this.subject, this.snapshot, true);
  }

  range(state: MatchState, group = 0): readonly [number, number] | undefined {
    const range = state.groups[group];
    if (!range) return undefined;
    const source = state.snapshot ?? this.snapshot;
    return [regexpByteIndex(source, range[0]), regexpByteIndex(source, range[1])];
  }

  next(state: MatchState): number {
    const [from, to] = state.groups[0]!;
    const source = state.snapshot ?? this.snapshot;
    if (from !== to) return regexpByteIndex(source, to);
    const point = source.s.codePointAt(to);
    return point === undefined ? this.length + 1 : regexpByteIndex(source, to + (point > 0xff_ff ? 2 : 1));
  }

  refresh(): void {
    const { subject, snapshot } = this;
    if (
      subject.s === snapshot.s &&
      subject.rawBytes === snapshot.rawBytes &&
      subject.binary === snapshot.binary &&
      subject.usAscii === snapshot.usAscii &&
      subject.frozen === snapshot.frozen
    )
      return;
    const bytes = stringBytes(subject);
    if (bytes.length !== this.length) throw rubyError(rt().c.RuntimeError, 'string modified');
    validateRegexpSubject(this.regexp, subject);
    this.snapshot = matchSnapshot(subject);
    this.bytes = bytes;
  }

  slice(from: number, to = this.length, original = false): RString {
    const source = original ? this.initial : this.snapshot;
    const bytes = original ? this.initialBytes : this.bytes;
    return stringFromBytes(bytes.subarray(from, to), source.binary, source.usAscii);
  }
}
