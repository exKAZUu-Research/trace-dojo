import { rubyError } from './errors';
import {
  execAt,
  matchSnapshot,
  type MatchSnapshotPolicy,
  type MatchState,
  validateRegexpByteView,
  validateRegexpSubject,
} from './libRegexp';
import type { RObject, RString } from './objects';
import { charIndex, regexpByteIndex, regexpByteUnit } from './regexpPositions';
import { rt } from './runtime';
import { str, stringBytes, stringFromBytes } from './values';

export class RegexpCursor {
  readonly length: number;
  snapshot: RString;
  private bytes: Uint8Array;

  constructor(
    private readonly regexp: RObject,
    private readonly subject: RString,
    private readonly snapshotPolicy: MatchSnapshotPolicy = 'preserveClass'
  ) {
    this.snapshot = matchSnapshot(subject, this.snapshotPolicy);
    this.bytes = stringBytes(this.snapshot);
    this.length = this.bytes.length;
    validateRegexpSubject(regexp, subject);
  }

  match(byte: number): MatchState | undefined {
    if (byte > this.length) return undefined;
    const unit = regexpByteUnit(this.snapshot, byte);
    if (regexpByteIndex(this.snapshot, unit) === byte)
      return execAt(this.regexp, this.snapshot.s, charIndex(this.snapshot.s, unit), this.subject, this.snapshot, true);
    validateRegexpByteView(this.regexp);
    const head = stringFromBytes(this.bytes.subarray(0, byte));
    const tail = stringFromBytes(this.bytes.subarray(byte));
    const view = str(head.s + tail.s);
    const state = execAt(this.regexp, view.s, charIndex(view.s, head.s.length), this.subject, this.snapshot, true);
    if (!state) return undefined;
    rt().chargeSlots(state.groups.length * 3);
    const groups = state.groups.map(
      (range) => range && ([regexpByteIndex(view, range[0]), regexpByteIndex(view, range[1])] as const)
    );
    const aligned = groups.every(
      (range) =>
        !range ||
        range.every((offset) => regexpByteIndex(this.snapshot, regexpByteUnit(this.snapshot, offset)) === offset)
    );
    if (aligned) {
      rt().chargeSlots(groups.length * 3);
      state.text = this.snapshot.s;
      state.groups = groups.map(
        (range) => range && [regexpByteUnit(this.snapshot, range[0]), regexpByteUnit(this.snapshot, range[1])]
      );
    } else state.byteView = { groups, bytes: this.bytes };
    return state;
  }

  range(state: MatchState, group = 0): readonly [number, number] | undefined {
    if (state.byteView) return state.byteView.groups[group];
    const range = state.groups[group];
    if (!range) return undefined;
    const source = state.snapshot ?? this.snapshot;
    return [regexpByteIndex(source, range[0]), regexpByteIndex(source, range[1])];
  }

  next(state: MatchState, current = false): number {
    const [from, to] = this.range(state)!;
    if (from !== to) return to;
    return this.nextCharacter(to, current ? this.snapshot : (state.snapshot ?? this.snapshot));
  }

  nextCharacter(to: number, source = this.snapshot): number {
    if (source.binary) return to + 1;
    const unit = regexpByteUnit(source, to);
    if (regexpByteIndex(source, unit) !== to) return to + 1;
    const point = source.s.codePointAt(unit);
    return point === undefined ? this.length + 1 : regexpByteIndex(source, unit + (point > 0xff_ff ? 2 : 1));
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
    this.snapshot = matchSnapshot(subject, this.snapshotPolicy);
    this.bytes = bytes;
  }

  slice(from: number, to = this.length): RString {
    return stringFromBytes(this.bytes.subarray(from, to), this.snapshot.binary, this.snapshot.usAscii);
  }
}
