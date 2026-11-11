import { classDefinitions } from '../classes';
import { pyRepr } from '../conversions';
import { builtin } from '../define';
import type { Frame } from '../frame';
import { getAttribute } from '../objects';
import { blockOf } from '../programSource';
import { currentRuntime } from '../runtimeContext';
import { codeClass, codeObject, frameClass, infoOf, PyTraceback } from '../tracebacks';
import { exceptionClassNamed, newException, newTuple, typeError, typeName } from '../types';
import { UnsupportedFeatureError } from '../unsupported';
import { PyBoundMethod, PyClass, PyError, PyFunction, PyModule, PyOpaque, type PyValue } from '../values';

/**
 * The natives of the parts of inspect that read source code, which find the lines of the program, as CPython reads the
 * script's file; the code of the standard library, which CPython reads from its files, is not the same here.
 */
export function inspectSourceNatives(): [string, PyValue][] {
  return [
    ['_findsource', builtin('_findsource', 'one', 1, 1, ([value]) => findSource(value))],
    [
      '_getblock',
      builtin('_getblock', 'one', 1, 1, ([lines]) => {
        const runtime = currentRuntime();
        return runtime.listOf(blockOf(runtime.toArray(lines) as string[]));
      }),
    ],
    [
      '_has_abstract_methods',
      builtin('_has_abstract_methods', 'one', 1, 1, ([cls]) => {
        const abstract = (cls as PyClass).dict.get('__abstractmethods__');
        return abstract !== undefined && currentRuntime().toArray(abstract).length > 0;
      }),
    ],
  ];
}

const LIBRARY_SOURCE = '標準ライブラリのソースコード（inspect）';

/** `inspect.findsource`: all the lines of the program and the index of the line an object starts on. */
function findSource(value: PyValue): PyValue {
  const runtime = currentRuntime();
  const program = runtime.program;
  const lines = (): PyValue => runtime.listOf(program?.lines ?? []);
  if (value instanceof PyModule) {
    if (value.name === '__main__' && program) return newTuple([lines(), 0n]);
    if (!value.dict.has('__file__')) throw typeError(`${pyRepr(value)} is a built-in module`);
    throw new UnsupportedFeatureError(LIBRARY_SOURCE);
  }
  if (value instanceof PyClass) return newTuple([lines(), BigInt(classRow(value))]);
  const code = codeOf(value);
  const info = infoOf(code);
  if (info.scope && program?.definitions.has(info.scope)) return newTuple([lines(), BigInt(info.firstRow)]);
  if (info.filename !== undefined || (info.fn && !runtime.libraryNamespaces.has(info.fn.globals))) {
    throw osError('could not get source code');
  }
  throw new UnsupportedFeatureError(LIBRARY_SOURCE);
}

function classRow(cls: PyClass): number {
  if (cls.isBuiltin) throw typeError(`${pyRepr(cls)} is a built-in class`);
  const definition = classDefinitions.get(cls);
  const first = cls.dict.get('__firstlineno__');
  if (definition && currentRuntime().program?.definitions.has(definition) && typeof first === 'bigint') {
    return Number(first) - 1;
  }
  if (first === undefined && cls.module === '__main__') throw osError('source code not available');
  throw new UnsupportedFeatureError(LIBRARY_SOURCE);
}

/** The code object of a function, method, traceback, frame, or code object, as findsource follows them. */
function codeOf(value: PyValue): PyOpaque {
  let target = value instanceof PyBoundMethod ? value.fn : value;
  if (target instanceof PyFunction) target = getAttribute(target, '__code__');
  if (target instanceof PyTraceback) return codeObject(target.frame);
  if (target instanceof PyOpaque && target.cls === frameClass) return codeObject(target.data as Frame);
  if (target instanceof PyOpaque && target.cls === codeClass) return target;
  throw typeError(
    `module, class, method, function, traceback, frame, or code object was expected, got ${typeName(value)}`
  );
}

function osError(message: string): PyError {
  return new PyError(newException(exceptionClassNamed('OSError'), [message]));
}
