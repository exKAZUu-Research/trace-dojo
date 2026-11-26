import type { IteratorState } from '../iterators';
import { defineNatives, type NativeCall } from '../natives';
import { type MethodSymbol, type NamedType, type Type } from '../types';
import { Cell, type CsObject, CsStruct, type Value } from '../values';
import { linkedSource, tokenOf, tokenSource } from './nativesCancellation';
import { valueTaskObject } from './nativesTasks';
import { callImplementation, evaluatorOf, failNull, libraryType, nullReference } from './support';

/**
 * `ConfigureAwait` and `WithCancellation` of async streams, whose `await foreach` passes the token to the stream's
 * `GetAsyncEnumerator`. Continuations run on the one thread either way, so the captured context changes nothing.
 */

const CONFIGURED = 'System.Runtime.CompilerServices.ConfiguredCancelableAsyncEnumerable';
const CONFIGURED_TASK = 'System.Runtime.CompilerServices.ConfiguredTaskAwaitable';

/** Calls an interface's method or property getter on a value, as the implementation its runtime type has. */
function callInterface(
  call: NativeCall,
  face: string,
  arity: number,
  member: string,
  receiver: Value,
  args: Value[]
): Value {
  if (receiver === undefined) nullReference();
  const symbol = evaluatorOf(call).runtime.library.typeNamed(face, arity);
  const method = (symbol.methods.find((candidate) => candidate.name === member) ??
    symbol.properties.find((property) => property.name === member)?.getter) as MethodSymbol;
  return callImplementation(call, method, receiver, args);
}

function elementTypeOf(receiver: Value): Type {
  return ((receiver as CsStruct).type as NamedType).args[0];
}

function configured(call: NativeCall, elementType: Type, source: Value, token: Value): CsStruct {
  return new CsStruct(libraryType(call, CONFIGURED, [elementType]), [source, token]);
}

/** A ValueTask's task, awaited through ConfiguredTaskAwaitable as this library's `ValueTask.ConfigureAwait` does. */
function configuredTask(call: NativeCall, valueTask: Value, resultType?: Type): CsStruct {
  return new CsStruct(libraryType(call, CONFIGURED_TASK, resultType ? [resultType] : []), [
    valueTaskObject(call, valueTask),
  ]);
}

defineNatives({
  'System.Threading.Tasks.TaskAsyncEnumerableExtensions.ConfigureAwait(IAsyncEnumerable<T>, bool)': (
    call,
    _receiver,
    [source]
  ) => {
    if (source === undefined) failNull('source');
    return configured(call, call.typeArgs[0], source as Value, tokenOf(call, undefined));
  },
  'System.Threading.Tasks.TaskAsyncEnumerableExtensions.WithCancellation': (call, _receiver, [source, token]) => {
    if (source === undefined) failNull('source');
    return configured(call, call.typeArgs[0], source as Value, token as Value);
  },
  'System.Threading.Tasks.TaskAsyncEnumerableExtensions.ConfigureAwait(IAsyncDisposable, bool)': (
    call,
    _receiver,
    [source]
  ) => {
    if (source === undefined) failNull('source');
    return new CsStruct(libraryType(call, 'System.Runtime.CompilerServices.ConfiguredAsyncDisposable'), [
      source as Value,
    ]);
  },
  [`${CONFIGURED}\`1.ConfigureAwait`]: (call, receiver) => {
    const [source, token] = (receiver as CsStruct).fields;
    return configured(call, elementTypeOf(receiver), source, token);
  },
  [`${CONFIGURED}\`1.WithCancellation`]: (call, receiver, [token]) =>
    configured(call, elementTypeOf(receiver), (receiver as CsStruct).fields[0], token as Value),
  [`${CONFIGURED}\`1.GetAsyncEnumerator`]: (call, receiver) => {
    const [source, token] = (receiver as CsStruct).fields;
    const enumerator = callInterface(
      call,
      'System.Collections.Generic.IAsyncEnumerable',
      1,
      'GetAsyncEnumerator',
      source,
      [token]
    );
    return new CsStruct(libraryType(call, `${CONFIGURED}\`1+Enumerator`, [elementTypeOf(receiver)]), [enumerator]);
  },
  [`${CONFIGURED}\`1+Enumerator.get_Current`]: (call, receiver) =>
    callInterface(
      call,
      'System.Collections.Generic.IAsyncEnumerator',
      1,
      'Current',
      (receiver as CsStruct).fields[0],
      []
    ),
  [`${CONFIGURED}\`1+Enumerator.MoveNextAsync`]: (call, receiver) =>
    configuredTask(
      call,
      callInterface(
        call,
        'System.Collections.Generic.IAsyncEnumerator',
        1,
        'MoveNextAsync',
        (receiver as CsStruct).fields[0],
        []
      ),
      libraryType(call, 'System.Boolean')
    ),
  [`${CONFIGURED}\`1+Enumerator.DisposeAsync`]: (call, receiver) =>
    configuredTask(
      call,
      callInterface(call, 'System.IAsyncDisposable', 0, 'DisposeAsync', (receiver as CsStruct).fields[0], [])
    ),
  'System.Runtime.CompilerServices.ConfiguredAsyncDisposable.DisposeAsync': (call, receiver) => {
    const valueTask = callInterface(
      call,
      'System.IAsyncDisposable',
      0,
      'DisposeAsync',
      (receiver as CsStruct).fields[0],
      []
    );
    // `await using` calls the IAsyncDisposable implementation, which returns the ValueTask itself.
    return call.method.explicitInterface ? valueTask : configuredTask(call, valueTask);
  },
});

/**
 * Gives an async iterator's `[EnumeratorCancellation]` parameter the token of `GetAsyncEnumerator`, as the compiler's
 * enumerators do: the given token when the call passed none or the same, else one that either cancels.
 */
export function passEnumeratorToken(call: NativeCall, state: IteratorState, token: Value): void {
  const given = tokenSource(token);
  if (given === undefined) return;
  const index = state.method.parameters.findIndex((parameter) => parameter.isEnumeratorCancellation);
  if (index === -1) return;
  const local = state.method.locals[index];
  const slot = state.frame.slots[local.slot];
  const own = tokenSource((slot instanceof Cell ? slot.value : slot) as Value);
  if (own === given) return;
  const source = own === undefined ? given : linkedSource(call, [tokenOf(call, own), token]);
  const value = tokenOf(call, source as CsObject);
  if (slot instanceof Cell) slot.value = value;
  else state.frame.slots[local.slot] = value;
}
