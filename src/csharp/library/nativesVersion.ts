import { INVARIANT } from '../cultures';
import { defineNatives, type NativeCall, type NativeMethod } from '../natives';
import { CsObject, type Value } from '../values';
import { NumberStyles, parseIntegerText } from './numberParsing';
import { fail, failNegative, failNull, libraryType, refOf } from './support';

const VERSION = 'System.Version';
const INT32_RANGE = [-(2n ** 31n), 2n ** 31n - 1n] as const;
/** The runtime's version, which `Environment.Version` reports: that of .NET 10.0.403's runtime. */
const RUNTIME_VERSION = [10, 0, 14] as const;

/** A Version's components, with -1 for a build or revision it lacks, as .NET keeps them. */
class VersionState {
  constructor(
    readonly major: number,
    readonly minor: number,
    readonly build = -1,
    readonly revision = -1
  ) {}

  /** The number of components that `ToString()` shows: 2 to 4, up to the last one present. */
  get fieldCount(): number {
    if (this.build === -1) return 2;
    return this.revision === -1 ? 3 : 4;
  }

  text(fieldCount: number): string {
    return [this.major, this.minor, this.build, this.revision].slice(0, fieldCount).join('.');
  }
}

function stateOf(value: Value): VersionState {
  return (value as CsObject).native as VersionState;
}

function newVersion(call: NativeCall, state: VersionState): CsObject {
  const object = new CsObject(libraryType(call, VERSION), []);
  object.native = state;
  return object;
}

/** A version of components, each of which must not be negative, as `ArgumentOutOfRangeException.ThrowIfNegative` checks. */
function checkedState(call: NativeCall, components: number[], names: readonly string[]): VersionState {
  for (const [index, component] of components.entries()) if (component < 0) failNegative(call, names[index], component);
  const [major, minor, build, revision] = components;
  return new VersionState(major, minor, build, revision);
}

const COMPONENT_NAMES = ['major', 'minor', 'build', 'revision'] as const;

/**
 * .NET's `Version.Parse`: two to four components separated by dots, each read as `int.Parse` reads an integer in the
 * invariant culture and not negative. `TryParse` gets undefined for any failure, which `Parse` throws.
 */
function parseVersion(call: NativeCall, input: string, throwsOnFailure: boolean): VersionState | undefined {
  const components = input.split('.');
  if (components.length < 2 || components.length > 4) {
    if (throwsOnFailure) fail('System.ArgumentException', 'Version string portion was too short or too long.', 'input');
    return undefined;
  }
  const values: number[] = [];
  for (const component of components) {
    const parsed = parseIntegerText(component, NumberStyles.Integer, INVARIANT, INT32_RANGE);
    if (typeof parsed === 'bigint' && parsed >= 0n) {
      values.push(Number(parsed));
      continue;
    }
    if (!throwsOnFailure) return undefined;
    if (parsed === 'format')
      fail('System.FormatException', `The input string '${component}' was not in a correct format.`);
    if (parsed === 'overflow')
      fail('System.OverflowException', 'Value was either too large or too small for an Int32.');
    failNegative(call, 'input', parsed);
  }
  const [major, minor, build, revision] = values;
  return new VersionState(major, minor, build, revision);
}

/** `Version.CompareTo(Version)`, which puts null first and compares the components in order. */
function compareVersions(a: VersionState, b: VersionState | undefined): number {
  if (!b) return 1;
  const pairs = [
    [a.major, b.major],
    [a.minor, b.minor],
    [a.build, b.build],
    [a.revision, b.revision],
  ];
  for (const [x, y] of pairs) if (x !== y) return x > y ? 1 : -1;
  return 0;
}

function sameVersion(a: Value, b: Value): boolean {
  if (a === undefined || b === undefined) return a === b;
  return compareVersions(stateOf(a), stateOf(b)) === 0;
}

/** The operators `<` and `<=`, for which null is less than any version; `>` and `>=` swap their operands. */
function ordering(test: (order: number) => boolean, nullFirst: (other: Value) => boolean): NativeMethod {
  return (_call, _receiver, [left, right]) => {
    const [a, b] = [left as Value, right as Value];
    if (a === undefined) return nullFirst(b);
    return test(compareVersions(stateOf(a), b === undefined ? undefined : stateOf(b)));
  };
}

const isLess = ordering(
  (order) => order < 0,
  (other) => other !== undefined
);
const isLessOrEqual = ordering(
  (order) => order <= 0,
  () => true
);

defineNatives({
  [`${VERSION}..ctor()`]: (_call, receiver) => {
    (receiver as CsObject).native = new VersionState(0, 0);
    return;
  },
  [`${VERSION}..ctor(string)`]: (call, receiver, [input]) => {
    if (input === undefined) failNull('input');
    (receiver as CsObject).native = parseVersion(call, input as string, true);
    return;
  },
  [`${VERSION}..ctor`]: (call, receiver, args) => {
    (receiver as CsObject).native = checkedState(call, args as number[], COMPONENT_NAMES);
    return;
  },
  'System.Environment.get_Version': (call) => newVersion(call, new VersionState(...RUNTIME_VERSION)),
  [`${VERSION}.get_Major`]: (_call, receiver) => stateOf(receiver).major,
  [`${VERSION}.get_Minor`]: (_call, receiver) => stateOf(receiver).minor,
  [`${VERSION}.get_Build`]: (_call, receiver) => stateOf(receiver).build,
  [`${VERSION}.get_Revision`]: (_call, receiver) => stateOf(receiver).revision,
  // The revision's high and low 16 bits, as shorts.
  [`${VERSION}.get_MajorRevision`]: (_call, receiver) => stateOf(receiver).revision >> 16,
  [`${VERSION}.get_MinorRevision`]: (_call, receiver) => ((stateOf(receiver).revision & 0xff_ff) << 16) >> 16,
  [`${VERSION}.Clone`]: (call, receiver) => newVersion(call, stateOf(receiver)),
  [`${VERSION}.CompareTo(object)`]: (_call, receiver, [other]) => {
    if (other === undefined) return 1;
    if (!(other instanceof CsObject) || !(other.native instanceof VersionState))
      fail('System.ArgumentException', 'Object must be of type Version.', 'version');
    return compareVersions(stateOf(receiver), other.native);
  },
  [`${VERSION}.CompareTo(Version)`]: (_call, receiver, [other]) =>
    compareVersions(stateOf(receiver), other === undefined ? undefined : stateOf(other as Value)),
  [`${VERSION}.Equals`]: (_call, receiver, [other]) =>
    other instanceof CsObject && other.native instanceof VersionState && sameVersion(receiver, other),
  // .NET packs the low bits of each component into one int.
  [`${VERSION}.GetHashCode`]: (_call, receiver) => {
    const { major, minor, build, revision } = stateOf(receiver);
    return ((major & 0xf) << 28) | ((minor & 0xff) << 20) | ((build & 0xff) << 12) | (revision & 0xf_ff);
  },
  [`${VERSION}.ToString()`]: (_call, receiver) => stateOf(receiver).text(stateOf(receiver).fieldCount),
  [`${VERSION}.ToString(int)`]: (_call, receiver, [fieldCount]) => {
    const state = stateOf(receiver);
    const count = fieldCount as number;
    if (count < 0 || count > state.fieldCount)
      fail('System.ArgumentException', `Argument must be between 0 and ${state.fieldCount}.`, 'fieldCount');
    return state.text(count);
  },
  [`${VERSION}.Parse`]: (call, _receiver, [input]) => {
    if (input === undefined) failNull('input');
    return newVersion(call, parseVersion(call, input as string, true) as VersionState);
  },
  [`${VERSION}.TryParse`]: (call, _receiver, [input, result]) => {
    const state = input === undefined ? undefined : parseVersion(call, input as string, false);
    refOf(result as Value).set(state && newVersion(call, state));
    return state !== undefined;
  },
  [`${VERSION}.op_Equality`]: (_call, _receiver, [a, b]) => sameVersion(a as Value, b as Value),
  [`${VERSION}.op_Inequality`]: (_call, _receiver, [a, b]) => !sameVersion(a as Value, b as Value),
  [`${VERSION}.op_LessThan`]: isLess,
  [`${VERSION}.op_LessThanOrEqual`]: isLessOrEqual,
  [`${VERSION}.op_GreaterThan`]: (call, receiver, [a, b]) => isLess(call, receiver, [b, a]),
  [`${VERSION}.op_GreaterThanOrEqual`]: (call, receiver, [a, b]) => isLessOrEqual(call, receiver, [b, a]),
});
