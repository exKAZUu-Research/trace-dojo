// oxlint-disable unicorn/prefer-code-point -- C# characters are UTF-16 code units, which code points would merge.
import type { NativeCall } from '../natives';
import { PendingException } from '../numeric';
import { environmentOf } from '../objects';
import type { NativeState } from '../runtime';
import { type MethodSymbol, substitute, substitutionOf, type Type } from '../types';
import { CsArray, CsObject, CsStruct, isString, stringText, type Value } from '../values';
import { evaluatorOf, fail, failNull } from './support';

/** The state of a library collection, which natives enumerate without calling the program back. */
export interface EnumerableState extends NativeState {
  enumerate(): Iterable<Value>;
  /** The elements and how a trace shows them, as an array or as an object keyed by its keys. */
  display?(): { kind: 'array' | 'object'; items: [string, Value, Type][] };
}

export function isEnumerableState(native: unknown): native is EnumerableState {
  return native instanceof Object && typeof (native as EnumerableState).enumerate === 'function';
}

export const collectionModified = (): PendingException =>
  new PendingException(
    'System.InvalidOperationException',
    'Collection was modified; enumeration operation may not execute.'
  );

/**
 * Enumerates any `IEnumerable`: arrays, strings, and library collections directly, and the program's own enumerables
 * through `GetEnumerator`, `MoveNext`, and `Current`, as `foreach` does.
 */
export function* iterate(call: NativeCall, value: Value, parameterName = 'source'): Generator<Value> {
  if (value === undefined) failNull(parameterName);
  if (value instanceof CsArray) {
    yield* value.values;
    return;
  }
  if (isString(value)) {
    const text = stringText(value);
    for (let index = 0; index < text.length; index++) yield text.charCodeAt(index);
    return;
  }
  if ((value instanceof CsObject || value instanceof CsStruct) && isEnumerableState(value.native)) {
    yield* value.native.enumerate();
    return;
  }
  yield* enumerateThroughInterface(call, value);
}

// code-gauge-allow functionNcss 33 -- One case per kind of syntax or value that the function handles.
function* enumerateThroughInterface(call: NativeCall, value: Value): Generator<Value> {
  const evaluator = evaluatorOf(call);
  const runtime = evaluator.runtime;
  const library = runtime.library;
  const generic = library.typeNamed('System.Collections.Generic.IEnumerable', 1);
  const nonGeneric = library.typeNamed('System.Collections.IEnumerable');
  const getEnumerator = (generic.methods.find((method) => method.name === 'GetEnumerator') ??
    nonGeneric.methods.find((method) => method.name === 'GetEnumerator')) as MethodSymbol;
  let implementation = runtime.dispatch(getEnumerator, value);
  if (implementation === getEnumerator)
    implementation = runtime.dispatch(
      nonGeneric.methods.find((method) => method.name === 'GetEnumerator') as MethodSymbol,
      value
    );
  if (implementation.isAbstract) fail('System.InvalidCastException', 'Specified cast is not valid.');
  const enumerator = evaluator.invoke(
    call.frame,
    implementation,
    value,
    [],
    undefined,
    environmentOf(evaluator, implementation, value)
  );
  if (enumerator === undefined)
    fail('System.NullReferenceException', 'Object reference not set to an instance of an object.');
  if (
    (enumerator instanceof CsObject || enumerator instanceof CsStruct) &&
    enumerator.native &&
    typeof (enumerator.native as LibraryEnumerator).next === 'function'
  ) {
    yield* (enumerator.native as LibraryEnumerator).remaining();
    return;
  }
  const enumeratorInterface = library.typeNamed('System.Collections.IEnumerator');
  const moveNext = enumeratorInterface.methods.find((method) => method.name === 'MoveNext') as MethodSymbol;
  const genericEnumerator = library.typeNamed('System.Collections.Generic.IEnumerator', 1);
  const current = (genericEnumerator.properties.find((property) => property.name === 'Current')?.getter ??
    enumeratorInterface.properties.find((property) => property.name === 'Current')?.getter) as MethodSymbol;
  call.frame.temporaries.push(enumerator);
  try {
    const moveNextImplementation = runtime.dispatch(moveNext, enumerator);
    let currentImplementation = runtime.dispatch(current, enumerator);
    if (currentImplementation === current)
      currentImplementation = runtime.dispatch(
        enumeratorInterface.properties.find((property) => property.name === 'Current')?.getter as MethodSymbol,
        enumerator
      );
    for (;;) {
      if (
        !(evaluator.invoke(
          call.frame,
          moveNextImplementation,
          enumerator,
          [],
          undefined,
          environmentOf(evaluator, moveNextImplementation, enumerator)
        ) as boolean)
      )
        return;
      yield evaluator.invoke(
        call.frame,
        currentImplementation,
        enumerator,
        [],
        undefined,
        environmentOf(evaluator, currentImplementation, enumerator)
      );
    }
  } finally {
    call.frame.temporaries.pop();
  }
}

/** An enumerator of a library collection or a LINQ query, which keeps the iteration of its source. */
export class LibraryEnumerator implements NativeState {
  current: Value = undefined;
  private state: 'before' | 'running' | 'after' = 'before';

  constructor(
    private readonly iterator: Iterator<Value>,
    private readonly holds: Value[] = []
  ) {}

  next(): boolean {
    if (this.state === 'after') return false;
    const result = this.iterator.next();
    if (result.done) {
      this.state = 'after';
      this.current = undefined;
      return false;
    }
    this.state = 'running';
    this.current = result.value;
    return true;
  }

  /** The current element, which .NET's library enumerators return as the default before starting and after ending. */
  currentValue(call: NativeCall): Value {
    if (this.state === 'running') return this.current;
    const type = call.owner ? substitute(call.method.returnType, substitutionOf(call.owner)) : call.method.returnType;
    return evaluatorOf(call).defaultOf(call.frame.resolve(type));
  }

  *remaining(): Generator<Value> {
    while (this.next()) yield this.current;
  }

  references(): Value[] {
    return [this.current, ...this.holds];
  }
}
