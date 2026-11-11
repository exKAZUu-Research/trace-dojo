import { bytesLikeData, latin1Text } from '../../bytesValues';
// `re.Scanner`, the undocumented tokenizer of Lib/re/__init__.py, which joins one pattern per token kind.
import { callValue, getItem, isCallable, toArray } from '../../objects';
import { currentRuntime } from '../../runtimeContext';
import {
  builtinClass,
  defineMethod,
  newTuple,
  None,
  pyError,
  sliceClass,
  typeError,
  typeName,
  unbox,
  valueError,
} from '../../types';
import { PyInstance, PySlice, type PyValue } from '../../values';
import { pythonArgs } from './arguments';
import { compilePattern } from './compiler';
import { FLAG } from './constants';
import { dumpPattern, printText } from './debugDump';
import { flagValue, isFlag } from './flags';
import type { newMatch } from './match';
import { parse, ParseState, SubPattern } from './parser';
import { PatternObject, ScannerObject, startSearch, syntaxError } from './pattern';
import { PatternSyntaxError } from './tokenizer';

export const lexiconScannerClass = builtinClass('Scanner');
lexiconScannerClass.module = 're';

lexiconScannerClass.construct = (cls, args, kwargs) => {
  const bound = pythonArgs(
    'Scanner.__init__',
    [
      { name: 'lexicon', kind: 'positional' },
      { name: 'flags', kind: 'positional', default: 0n },
    ],
    args,
    kwargs
  );
  const lexicon = bound.get('lexicon') as PyValue;
  const flagsValue = bound.get('flags') as PyValue;
  const flags = Number(isFlag(flagsValue) ? flagValue(flagsValue) : BigInt(flagsValue as bigint | boolean));
  const scanner = new PyInstance(cls);
  scanner.dict.set('lexicon', lexicon);
  scanner.dict.set('scanner', combinedPattern(lexicon, flags));
  return scanner;
};

/** The pattern whose n-th group is the n-th phrase of the lexicon. */
function combinedPattern(lexicon: PyValue, flags: number): PatternObject {
  const state = new ParseState();
  state.flags = flags;
  const branches: SubPattern[] = [];
  for (const entry of toArray(lexicon)) {
    const [phrase] = unpackPair(entry);
    const gid = state.opengroup(undefined);
    const branch = new SubPattern(state, [
      { op: 'SUBPATTERN', group: gid, addFlags: 0, delFlags: 0, pattern: parsePhrase(phrase, flags) },
    ]);
    branches.push(branch);
    state.closegroup(gid, branch);
  }
  if (branches.length === 0) throw pyError('RuntimeError', 'invalid SRE code');
  const program = compilePattern(new SubPattern(state, [{ op: 'BRANCH', branches }]), flags);
  return new PatternObject(undefined, flags, program, state.groups - 1, new Map(), None, undefined);
}

function unpackPair(entry: PyValue): PyValue[] {
  const items = toArray(entry);
  if (items.length < 2) throw valueError(`not enough values to unpack (expected 2, got ${items.length})`);
  if (items.length > 2) throw valueError(`too many values to unpack (expected 2, got ${items.length})`);
  return items;
}

function parsePhrase(phrase: PyValue, flags: number): SubPattern {
  const text = unbox(phrase);
  const data = typeof text === 'string' ? undefined : bytesLikeData(phrase);
  if (typeof text !== 'string' && data === undefined) {
    throw typeError(`decoding to str: need a bytes-like object, ${typeName(phrase)} found`);
  }
  try {
    const parsed = data === undefined ? parse(text as string, flags) : parse(latin1Text(data), flags, false);
    if (flags & FLAG.DEBUG) printText(dumpPattern(parsed));
    return parsed;
  } catch (error) {
    if (error instanceof PatternSyntaxError) throw syntaxError(error, phrase);
    throw error;
  }
}

defineMethod(lexiconScannerClass, 'scan', (self, args, kwargs) => {
  const string = pythonArgs('Scanner.scan', [{ name: 'string', kind: 'positional' }], args, kwargs).get(
    'string'
  ) as PyValue;
  const instance = self as PyInstance;
  const pattern = instance.dict.get('scanner') as PatternObject;
  const search = startSearch(pattern, string);
  const scanner = new ScannerObject(pattern, search);
  const result: PyValue[] = [];
  let position = 0;
  for (;;) {
    const match = scanner.next('match');
    if (match === None) break;
    const { spans, lastindex } = match as ReturnType<typeof newMatch>;
    if (spans[1] === position) break;
    let action = getItem(getItem(instance.dict.get('lexicon') as PyValue, BigInt(lastindex - 1)), 1n);
    if (isCallable(action)) {
      instance.dict.set('match', match);
      action = callValue(action, [instance, (match as ReturnType<typeof newMatch>).group(0)]);
    }
    if (action !== None) result.push(action);
    position = spans[1];
  }
  const rest = getItem(string, new PySlice(sliceClass, BigInt(position), None, None));
  return newTuple([currentRuntime().listOf(result), rest]);
});
