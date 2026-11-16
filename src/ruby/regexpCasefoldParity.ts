import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RegExpParser, visitRegExpAST } from '@eslint-community/regexpp';
import { z } from 'zod';

import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import type { RegexpData } from './libRegexp';
import { unitIndex } from './regexpPositions';
import { rt, UnsupportedFeatureError } from './runtime';

const requireFromRoot = createRequire(path.join(process.cwd(), 'package.json'));
const wasmPath = requireFromRoot.resolve('@ruby/4.0-wasm-wasi/dist/ruby.wasm');
const bridge = requireFromRoot.resolve('@ruby/wasm-wasi/dist/browser');
const nativePath = fileURLToPath(new URL('regexpCasefoldProcess.cjs', import.meta.url));
const matchSchema = z.union([
  z.array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).nullable()).nullable(),
  z.enum(['timeout', 'unsupported']),
]);
type NativeRanges = (readonly [number, number] | null)[] | null;
interface NativePattern {
  text: string;
  searches: Map<number, NativeRanges>;
}
const searches = new WeakMap<object, Map<string, Map<string, NativePattern>>>();

export function assertCasefoldParity(
  data: RegexpData,
  text: string,
  start: number,
  result: RegExpExecArray | null,
  anchored: boolean
): void {
  const pattern = nativePattern(data, text);
  const native = nativeSearch(data, pattern, start);
  const ranges = native && (!anchored || native[0]?.[0] === start) ? native : undefined;
  if (!sameCaptureRanges(ranges, result?.indices, text))
    throw new UnsupportedFeatureError('Unicode の複数文字 casefold');
}

function nativePattern(data: RegexpData, text: string): NativePattern {
  const runtime = rt();
  let sources = searches.get(runtime);
  if (!sources) {
    sources = new Map();
    searches.set(runtime, sources);
  }
  const key = JSON.stringify([data.source, data.ignoreCase, data.extended, data.multiline]);
  let subjects = sources.get(key);
  if (!subjects) {
    assertBoundedPattern(data);
    runtime.chargeSlots(key.length + 1);
    subjects = new Map();
    sources.set(key, subjects);
  }
  let pattern = subjects.get(text);
  if (!pattern) {
    runtime.chargeSlots(text.length + 1);
    pattern = { text, searches: new Map() };
    subjects.set(text, pattern);
  }
  return pattern;
}

function nativeSearch(data: RegexpData, pattern: NativePattern, start: number): NativeRanges {
  const runtime = rt();
  const cached = pattern.searches.get(start);
  if (cached !== undefined) return cached;
  const remaining = runtime.budget.remainingMilliseconds;
  if (remaining === 0) throw new ExecutionLimitError('time');
  let output: string;
  try {
    output = execFileSync(process.execPath, [nativePath], {
      input: JSON.stringify({
        wasm: wasmPath,
        bridge,
        source: data.source,
        text: pattern.text,
        start,
        flags: (data.ignoreCase ? 1 : 0) | (data.extended ? 2 : 0) | (data.multiline ? 4 : 0),
        timeout: remaining / 1000,
      }),
      encoding: 'utf8',
      timeout: remaining,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024,
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ETIMEDOUT')
      throw new ExecutionLimitError('time');
    throw error;
  }
  const native = matchSchema.parse(JSON.parse(output));
  if (native === 'timeout') throw new ExecutionLimitError('time');
  if (native === 'unsupported') throw new UnsupportedFeatureError('Unicode の複数文字 casefold');
  runtime.chargeSlots(1 + (native?.length ?? 0) * 3);
  pattern.searches.set(start, native);
  runtime.spend(Math.ceil(Math.max(1, (native?.[0]?.[1] ?? pattern.text.length) - start) / 64));
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
