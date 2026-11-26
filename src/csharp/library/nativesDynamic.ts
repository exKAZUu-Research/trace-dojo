import { Reference } from '../evaluatorBase';
import { defineNatives, type NativeCall, type NativeMethod } from '../natives';
import { environmentOf } from '../objects';
import { displayType, type MethodSymbol, type NamedType, type Type } from '../types';
import { CsDelegate, CsObject, CsStruct, type Value, type VariableReference } from '../values';
import { collectionModified, type EnumerableState, LibraryEnumerator } from './iteration';
import { newList } from './nativesCollections';
import { typeObjectOf } from './nativesCore';
import { copyToArray, evaluatorOf, fail, failNull, libraryType, refOf, stateOf } from './support';

const EXPANDO = 'System.Dynamic.ExpandoObject';
const DYNAMIC_OBJECT = 'System.Dynamic.DynamicObject';
const RUNTIME_BINDER_EXCEPTION = 'Microsoft.CSharp.RuntimeBinder.RuntimeBinderException';

/**
 * The members of an ExpandoObject in the order they were first added: removing one leaves its place, which adding it
 * again takes back, as .NET's ExpandoObject keeps its members' slots.
 */
class ExpandoState implements EnumerableState {
  private readonly names: string[] = [];
  private readonly values: Value[] = [];
  private readonly present: boolean[] = [];
  private readonly slots = new Map<string, number>();
  version = 0;

  constructor(
    private readonly pairType: NamedType,
    private readonly objectType: Type
  ) {}

  get count(): number {
    return this.present.filter(Boolean).length;
  }

  find(name: string): { isFound: boolean; value: Value } {
    const slot = this.slots.get(name);
    return slot !== undefined && this.present[slot]
      ? { isFound: true, value: this.values[slot] }
      : { isFound: false, value: undefined };
  }

  set(name: string, value: Value): void {
    const slot = this.slots.get(name);
    if (slot === undefined) {
      this.slots.set(name, this.names.length);
      this.names.push(name);
      this.values.push(value);
      this.present.push(true);
    } else {
      this.values[slot] = value;
      this.present[slot] = true;
    }
    this.version++;
  }

  remove(name: string): boolean {
    const slot = this.slots.get(name);
    if (slot === undefined || !this.present[slot]) return false;
    this.present[slot] = false;
    this.values[slot] = undefined;
    this.version++;
    return true;
  }

  clear(): void {
    this.present.fill(false);
    this.values.fill(undefined);
    this.version++;
  }

  entries(): [string, Value][] {
    return this.names.flatMap((name, slot) =>
      this.present[slot] ? [[name, this.values[slot]] as [string, Value]] : []
    );
  }

  *enumerate(): Generator<Value> {
    const version = this.version;
    for (const [name, value] of this.entries()) {
      if (this.version !== version) throw collectionModified();
      yield new CsStruct(this.pairType, [name, value]);
    }
    if (this.version !== version) throw collectionModified();
  }

  references(): Value[] {
    return this.values;
  }

  display(): { kind: 'object'; items: [string, Value, Type][] } {
    return { kind: 'object', items: this.entries().map(([name, value]) => [name, value, this.objectType]) };
  }
}

function expandoOf(receiver: Value): ExpandoState {
  return stateOf<ExpandoState>(receiver);
}

function checkedKey(key: Value): string {
  if (key === undefined) failNull('key');
  return key as string;
}

function addMember(call: NativeCall, receiver: Value, key: Value, value: Value): Value {
  const name = checkedKey(key);
  const state = expandoOf(receiver);
  if (state.find(name).isFound)
    fail(
      'System.ArgumentException',
      `An element with the same key '${name}' already exists in the ExpandoObject.`,
      'key'
    );
  call.frame.runtime.retainSlots(1, [value]);
  state.set(name, value);
  return undefined;
}

function setMember(call: NativeCall, receiver: Value, name: string, value: Value): Value {
  const state = expandoOf(receiver);
  call.frame.runtime.chargeStore(state.find(name).value, value);
  state.set(name, value);
  return undefined;
}

const PAIR = 'KeyValuePair<string, object>';

defineNatives({
  [`${EXPANDO}..ctor`]: (call, receiver) => {
    const objectType = libraryType(call, 'System.Object');
    const pairType = libraryType(call, 'System.Collections.Generic.KeyValuePair', [
      libraryType(call, 'System.String'),
      objectType,
    ]);
    (receiver as CsObject).native = new ExpandoState(pairType, objectType);
    return;
  },
  [`${EXPANDO}.get_Item(string)`]: (_call, receiver, [key]) => {
    const name = checkedKey(key as Value);
    const { isFound, value } = expandoOf(receiver).find(name);
    if (!isFound)
      fail(
        'System.Collections.Generic.KeyNotFoundException',
        `The specified key '${name}' does not exist in the ExpandoObject.`
      );
    return value;
  },
  [`${EXPANDO}.set_Item(string, object)`]: (call, receiver, [key, value]) =>
    setMember(call, receiver, checkedKey(key as Value), value as Value),
  [`${EXPANDO}.get_Keys`]: (call, receiver) =>
    newList(
      call,
      libraryType(call, 'System.String'),
      expandoOf(receiver)
        .entries()
        .map(([name]) => name)
    ),
  [`${EXPANDO}.get_Values`]: (call, receiver) =>
    newList(
      call,
      libraryType(call, 'System.Object'),
      expandoOf(receiver)
        .entries()
        .map(([, value]) => value)
    ),
  [`${EXPANDO}.get_Count`]: (_call, receiver) => expandoOf(receiver).count,
  [`${EXPANDO}.get_IsReadOnly`]: () => false,
  [`${EXPANDO}.Add(string, object)`]: (call, receiver, [key, value]) =>
    addMember(call, receiver, key as Value, value as Value),
  [`${EXPANDO}.Add(${PAIR})`]: (call, receiver, [pair]) =>
    addMember(call, receiver, (pair as CsStruct).fields[0], (pair as CsStruct).fields[1]),
  [`${EXPANDO}.ContainsKey`]: (_call, receiver, [key]) => expandoOf(receiver).find(checkedKey(key as Value)).isFound,
  [`${EXPANDO}.Contains(${PAIR})`]: (_call, receiver, [pair]) => {
    const [key, wanted] = (pair as CsStruct).fields;
    const { isFound, value } = expandoOf(receiver).find(checkedKey(key));
    return isFound && value === wanted;
  },
  [`${EXPANDO}.Remove(string)`]: (_call, receiver, [key]) => expandoOf(receiver).remove(checkedKey(key as Value)),
  [`${EXPANDO}.Remove(${PAIR})`]: (_call, receiver, [pair]) => {
    const [key, wanted] = (pair as CsStruct).fields;
    const state = expandoOf(receiver);
    const { isFound, value } = state.find(checkedKey(key));
    return isFound && value === wanted && state.remove(key as string);
  },
  [`${EXPANDO}.TryGetValue`]: (_call, receiver, [key, result]) => {
    const { isFound, value } = expandoOf(receiver).find(checkedKey(key as Value));
    refOf(result).set(value);
    return isFound;
  },
  [`${EXPANDO}.Clear`]: (_call, receiver) => {
    expandoOf(receiver).clear();
    return;
  },
  [`${EXPANDO}.CopyTo`]: (call, receiver, [array, index]) => {
    copyToArray(call, [...expandoOf(receiver).enumerate()], array as Value, index as number);
    return;
  },
  [`${EXPANDO}.GetEnumerator`]: (call, receiver) => {
    const state = expandoOf(receiver);
    const enumerator = new CsObject(
      libraryType(call, 'System.Linq.Internal.Enumerator', [
        libraryType(call, 'System.Collections.Generic.KeyValuePair', [
          libraryType(call, 'System.String'),
          libraryType(call, 'System.Object'),
        ]),
      ]),
      []
    );
    const enumerate = (): Iterator<Value> => state.enumerate();
    enumerator.native = new LibraryEnumerator(enumerate(), [receiver], enumerate);
    return enumerator;
  },
  // `e.Name` of `dynamic`: a member the ExpandoObject holds, which assigning adds.
  [`${EXPANDO}.get_Item(string, bool)`]: (call, receiver, [name]) => {
    const { isFound, value } = expandoOf(receiver).find(name as string);
    if (!isFound) failMissingMember(call, receiver, name as string);
    return value;
  },
  [`${EXPANDO}.set_Item(string, bool, dynamic)`]: (call, receiver, [name, , value]) =>
    setMember(call, receiver, name as string, value as Value),
});

// ---- DynamicObject ----

/** Throws the runtime binder's error for a member that an object neither has nor binds itself. */
function failMissingMember(call: NativeCall, receiver: Value, name: string): never {
  const type = call.frame.runtime.runtimeTypeOf(receiver) as Type;
  fail(RUNTIME_BINDER_EXCEPTION, `'${displayType(type, true)}' does not contain a definition for '${name}'`);
}

/** A binder that a DynamicObject's `Try` method receives, as the C# runtime binder creates it for an operation. */
function binderObject(call: NativeCall, kind: 'Get' | 'Set' | 'Invoke', name: string, argumentCount = 0): CsObject {
  const binder = new CsObject(libraryType(call, `Microsoft.CSharp.RuntimeBinder.CSharp${kind}MemberBinder`), []);
  const callInfo = new CsObject(libraryType(call, 'System.Dynamic.CallInfo'), []);
  callInfo.native = { argumentCount };
  binder.native = { name, callInfo };
  return binder;
}

/** Calls a DynamicObject's own `Try` method, or the base one that binds nothing. */
function callTry(call: NativeCall, receiver: Value, name: string, args: (Value | VariableReference)[]): boolean {
  const evaluator = evaluatorOf(call);
  const symbol = call.frame.runtime.library.typeNamed(DYNAMIC_OBJECT);
  const method = symbol.methods.find((candidate) => candidate.name === name) as MethodSymbol;
  const implementation = call.frame.runtime.dispatch(method, receiver);
  return evaluator.invoke(
    call.frame,
    implementation,
    receiver,
    args,
    call.row,
    environmentOf(evaluator, implementation, receiver)
  ) as boolean;
}

/** An `out object? result` argument, whose value the call leaves in it. */
function outArgument(): { reference: VariableReference; value: () => Value } {
  let value: Value;
  // A Reference, which a parameter's slot that holds it reads and writes through, as an `out` passed on does.
  const reference = new Reference(
    () => value,
    (assigned) => {
      value = assigned;
    }
  );
  return { reference, value: () => value };
}

function tryGetMember(call: NativeCall, receiver: Value, name: string): { isFound: boolean; value: Value } {
  const result = outArgument();
  const isFound = callTry(call, receiver, 'TryGetMember', [
    binderObject(call, 'Get', name),
    result.reference as unknown as Value,
  ]);
  return { isFound, value: result.value() };
}

const binderNatives = (kind: string): Record<string, NativeMethod> => ({
  [`System.Dynamic.${kind}MemberBinder.get_Name`]: (_call, receiver) => stateOf<{ name: string }>(receiver).name,
  [`System.Dynamic.${kind}MemberBinder.get_IgnoreCase`]: () => false,
  // The C# runtime binder's operations return `object`.
  [`System.Dynamic.${kind}MemberBinder.get_ReturnType`]: (call) =>
    typeObjectOf(call.frame.runtime, libraryType(call, 'System.Object')),
});

defineNatives({
  ...binderNatives('Get'),
  ...binderNatives('Set'),
  ...binderNatives('Invoke'),
  'System.Dynamic.InvokeMemberBinder.get_CallInfo': (_call, receiver) =>
    stateOf<{ callInfo: CsObject }>(receiver).callInfo,
  'System.Dynamic.CallInfo..ctor': (_call, receiver, [count]) => {
    (receiver as CsObject).native = { argumentCount: count };
    return;
  },
  'System.Dynamic.CallInfo.get_ArgumentCount': (_call, receiver) =>
    stateOf<{ argumentCount: number }>(receiver).argumentCount,
  [`${DYNAMIC_OBJECT}..ctor`]: () => {},
  [`${DYNAMIC_OBJECT}.TryGetMember`]: (_call, _receiver, [, result]) => {
    refOf(result).set(undefined);
    return false;
  },
  [`${DYNAMIC_OBJECT}.TrySetMember`]: () => false,
  [`${DYNAMIC_OBJECT}.TryInvokeMember`]: (_call, _receiver, args) => {
    refOf(args[2]).set(undefined);
    return false;
  },
  [`${DYNAMIC_OBJECT}.GetDynamicMemberNames`]: (call) => newList(call, libraryType(call, 'System.String'), []),
  // `d.Name` of `dynamic`, when the object's type has no such member: TryGetMember binds it.
  [`${DYNAMIC_OBJECT}.get_Item(string, bool)`]: (call, receiver, [name]) => {
    const { isFound, value } = tryGetMember(call, receiver, name as string);
    if (!isFound) failMissingMember(call, receiver, name as string);
    return value;
  },
  [`${DYNAMIC_OBJECT}.set_Item(string, bool, dynamic)`]: (call, receiver, [name, , value]) => {
    if (!callTry(call, receiver, 'TrySetMember', [binderObject(call, 'Set', name as string), value as Value]))
      failMissingMember(call, receiver, name as string);
    return;
  },
  // `d.Name(args)`: TryInvokeMember binds it, or else TryGetMember gives a delegate that the call invokes.
  [`${DYNAMIC_OBJECT}.InvokeMember`]: (call, receiver, [name, args]) => {
    const result = outArgument();
    const binder = binderObject(call, 'Invoke', name as string, (args as { values: Value[] }).values.length);
    if (callTry(call, receiver, 'TryInvokeMember', [binder, args as Value, result.reference as unknown as Value]))
      return result.value();
    const member = tryGetMember(call, receiver, name as string);
    if (!member.isFound) failMissingMember(call, receiver, name as string);
    if (!(member.value instanceof CsDelegate)) fail(RUNTIME_BINDER_EXCEPTION, 'Cannot invoke a non-delegate type');
    return invokeWithObjects(call, member.value, args as Value);
  },
});

/** Invokes a delegate with arguments that come as objects, as `Delegate.DynamicInvoke` does. */
function invokeWithObjects(call: NativeCall, target: CsDelegate, args: Value): Value {
  const dynamicInvoke = call.frame.runtime.library
    .typeNamed('System.Delegate')
    .methods.find((method) => method.name === 'DynamicInvoke') as MethodSymbol;
  const evaluator = evaluatorOf(call);
  return evaluator.invoke(call.frame, dynamicInvoke, target, [args], call.row, new Map());
}
