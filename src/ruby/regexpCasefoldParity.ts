import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { RegExpParser, visitRegExpAST } from '@eslint-community/regexpp';
import type { RbValue } from '@ruby/wasm-wasi';
import { DefaultRubyVM } from '@ruby/wasm-wasi/dist/browser';
import { z } from 'zod';

import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import type { RegexpData } from './libRegexp';
import { unitIndex } from './regexpPositions';
import { rt, UnsupportedFeatureError } from './runtime';

const requireFromRoot = createRequire(path.join(process.cwd(), 'package.json'));
const wasm = new Uint8Array(readFileSync(requireFromRoot.resolve('@ruby/4.0-wasm-wasi/dist/ruby.wasm')));
const { vm } = await DefaultRubyVM(await WebAssembly.compile(wasm), { consolePrint: false });
const compile = vm.eval(`$VERBOSE = nil
->(source, flags) do
  Regexp.new(source.to_s, flags.to_s.to_i)
rescue RegexpError
  nil
end`);
const search = vm.eval(`->(regexp, text, position, timeout) do
  return '"unsupported"' if regexp.nil?
  Regexp.timeout = timeout.to_s.to_f
  match = regexp.match(text, position.to_s.to_i)
  return "null" unless match
  "[" + (0...match.length).map { |i|
    match.begin(i) ? "[#{match.begin(i)},#{match.end(i)}]" : "null"
  }.join(",") + "]"
rescue Regexp::TimeoutError
  '"timeout"'
end`);
const matchSchema = z.union([
  z.array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).nullable()).nullable(),
  z.enum(['timeout', 'unsupported']),
]);
interface NativePattern {
  regexp: RbValue;
  text: string;
  subject: RbValue;
}
const patterns = new WeakMap<RegexpData, NativePattern>();

export function assertCasefoldParity(
  data: RegexpData,
  text: string,
  start: number,
  result: RegExpExecArray | null,
  anchored: boolean
): void {
  const pattern = nativePattern(data, text);
  const native = nativeSearch(pattern, start);
  const ranges = native && (!anchored || native[0]?.[0] === start) ? native : undefined;
  if (!sameCaptureRanges(ranges, result?.indices, text))
    throw new UnsupportedFeatureError('Unicode の複数文字 casefold');
}

function nativePattern(data: RegexpData, text: string): NativePattern {
  let pattern = patterns.get(data);
  if (!pattern) {
    assertBoundedPattern(data);
    const flags = (data.ignoreCase ? 1 : 0) | (data.extended ? 2 : 0) | (data.multiline ? 4 : 0);
    rt().chargeSlots(data.source.length + text.length);
    pattern = {
      regexp: compile.call('call', vm.wrap(data.source), vm.wrap(flags)),
      text,
      subject: vm.wrap(text).call('to_s'),
    };
    patterns.set(data, pattern);
  }
  if (pattern.text !== text) {
    rt().chargeSlots(text.length);
    pattern.subject = vm.wrap(text).call('to_s');
    pattern.text = text;
  }
  return pattern;
}

function nativeSearch(pattern: NativePattern, start: number): (readonly [number, number] | null)[] | null {
  const remaining = rt().budget.remainingMilliseconds;
  if (remaining === 0) throw new ExecutionLimitError('time');
  const native = matchSchema.parse(
    JSON.parse(
      search.call('call', pattern.regexp, pattern.subject, vm.wrap(start), vm.wrap(remaining / 1000)).toString()
    )
  );
  if (native === 'timeout') throw new ExecutionLimitError('time');
  if (native === 'unsupported') throw new UnsupportedFeatureError('Unicode の複数文字 casefold');
  rt().spend(Math.ceil(Math.max(1, (native?.[0]?.[1] ?? pattern.text.length) - start) / 64));
  return native;
}

function sameCaptureRanges(
  ranges: readonly (readonly [number, number] | null)[] | undefined,
  actual: RegExpExecArray['indices'],
  text: string
): boolean {
  if (!ranges) return actual === undefined;
  if (!actual || ranges.length !== actual.length) return false;
  return ranges.every((range, index) =>
    range
      ? actual[index]?.[0] === unitIndex(text, range[0]) && actual[index]?.[1] === unitIndex(text, range[1])
      : actual[index] === undefined
  );
}

// The bundled 4.0.0 compiler lacks the 4.0.9 overflow guards, so bound syntax and repeat counts before calling it.
function assertBoundedPattern(data: RegexpData): void {
  if (data.source.length > LIMITS.maxCallDepth) throw new UnsupportedFeatureError('Unicode の複数文字 casefold');
  const ast = new RegExpParser().parsePattern(data.js.source, 0, data.js.source.length, { unicode: true });
  visitRegExpAST(ast, {
    onQuantifierEnter(node) {
      if (node.min > LIMITS.maxCallDepth || (Number.isFinite(node.max) && node.max > LIMITS.maxCallDepth))
        throw new UnsupportedFeatureError('Unicode の複数文字 casefold');
    },
  });
}
