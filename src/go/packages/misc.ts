import type { Entity } from '../entities';
import { blockingFunction, definePackage, fn, namedType, nativeFunction, typeEntity } from '../native';
import { PANIC_NIL_ERROR, TYPE_ASSERTION_ERROR } from '../runtimeErrors';
import { scheduler } from '../scheduler';
import { ANY, BASIC } from '../types';

// runtime -------------------------------------------------------------------------------------------------------

function stringConstant(name: string, value: string): Entity {
  return {
    kind: 'const',
    name,
    type: BASIC.untypedString,
    value: { kind: 'string', value },
    span: { row: 0, column: 0 },
    used: true,
  };
}

const RUNTIME_ERROR = namedType('runtime', 'Error', {
  kind: 'interface',
  methods: [
    { name: 'Error', type: fn([], [BASIC.string]) },
    { name: 'RuntimeError', type: fn([], []) },
  ],
});

/** Calls that change nothing a single-goroutine program without finalizers can observe. */
const noOp = (name: string, params = []): Entity => nativeFunction(name, fn(params, []), () => []);

/** The platform and release of the reference toolchain that results are compared with, an arm64 Mac. */
const runtimeMembers: Record<string, Entity> = {
  GOOS: stringConstant('GOOS', 'darwin'),
  GOARCH: stringConstant('GOARCH', 'arm64'),
  Compiler: stringConstant('Compiler', 'gc'),
  Version: nativeFunction('Version', fn([], [BASIC.string]), () => 'go1.27.3'),
  Error: typeEntity(RUNTIME_ERROR),
  TypeAssertionError: typeEntity(TYPE_ASSERTION_ERROR),
  PanicNilError: typeEntity(PANIC_NIL_ERROR),
  Gosched: blockingFunction('Gosched', fn([], []), function* () {
    yield* scheduler().yieldTurn();
  }),
  LockOSThread: noOp('LockOSThread'),
  UnlockOSThread: noOp('UnlockOSThread'),
  KeepAlive: nativeFunction('KeepAlive', fn([ANY], []), () => []),
};

/**
 * The runtime package, without what reports the machine (NumCPU, GOMAXPROCS, GOROOT), the call stack's files and
 * addresses (Caller, Callers, Stack, FuncForPC), the garbage collector's timing (finalizers, cleanups, memory
 * statistics, profiles), or ends a goroutine (Goexit).
 */
export const RUNTIME_PACKAGE = definePackage('runtime', runtimeMembers, [
  'NumGoroutine',
  'GC',
  'NumCPU',
  'GOMAXPROCS',
  'Goexit',
  'Caller',
  'Callers',
  'FuncForPC',
  'SetFinalizer',
  'AddCleanup',
  'ReadMemStats',
  'MemStats',
  'Stack',
  'GOROOT',
  'Breakpoint',
]);
