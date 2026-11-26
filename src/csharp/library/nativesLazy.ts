import { defineNatives, type NativeCall } from '../natives';
import { PendingException } from '../numeric';
import { CsThrow } from '../runtime';
import { isReferenceType, type NamedType, substitutionOf } from '../types';
import { type CsObject, type Value } from '../values';
import { evaluatorOf, fail, failNull, nullReference, stateOf, textOf, typeArgument } from './support';

/** `LazyThreadSafetyMode`'s values. */
const PUBLICATION_ONLY = 1;
const EXECUTION_AND_PUBLICATION = 2;

/**
 * The state of a `Lazy<T>`. A factory's exception is kept and thrown again by every later read, as .NET does in every
 * mode but PublicationOnly; creating the value with T's parameterless constructor keeps none.
 */
class LazyState {
  status: 'pending' | 'creating' | 'created' | 'failed' = 'pending';
  value: Value;
  failure: CsThrow | undefined;

  constructor(
    readonly factory: Value | undefined,
    readonly mode: number
  ) {}

  /** Whether a value is there, which a factory that reads Value may have stored while it ran. */
  get isCreated(): boolean {
    return this.status === 'created';
  }

  references(): Value[] {
    return [this.value, this.factory, this.failure?.exception];
  }
}

function initialize(receiver: Value, factory: Value | undefined, mode: number, hasFactory: boolean): Value {
  if (hasFactory && factory === undefined) failNull('valueFactory');
  if (mode < 0 || mode > EXECUTION_AND_PUBLICATION)
    fail('System.ArgumentOutOfRangeException', 'The mode argument specifies an invalid value.', 'mode');
  (receiver as CsObject).native = new LazyState(factory, mode);
  return undefined;
}

const modeOf = (isThreadSafe: Value): number => (isThreadSafe ? EXECUTION_AND_PUBLICATION : 0);

defineNatives({
  'System.Lazy`1..ctor()': (_call, receiver) => initialize(receiver, undefined, EXECUTION_AND_PUBLICATION, false),
  'System.Lazy`1..ctor(bool)': (_call, receiver, [isThreadSafe]) =>
    initialize(receiver, undefined, modeOf(isThreadSafe as Value), false),
  'System.Lazy`1..ctor(LazyThreadSafetyMode)': (_call, receiver, [mode]) =>
    initialize(receiver, undefined, mode as number, false),
  'System.Lazy`1..ctor(Func<T>)': (_call, receiver, [factory]) =>
    initialize(receiver, factory as Value, EXECUTION_AND_PUBLICATION, true),
  'System.Lazy`1..ctor(Func<T>, bool)': (_call, receiver, [factory, isThreadSafe]) =>
    initialize(receiver, factory as Value, modeOf(isThreadSafe as Value), true),
  'System.Lazy`1..ctor(Func<T>, LazyThreadSafetyMode)': (_call, receiver, [factory, mode]) =>
    initialize(receiver, factory as Value, mode as number, true),
  'System.Lazy`1..ctor(T)': (_call, receiver, [value]) => {
    const state = new LazyState(undefined, EXECUTION_AND_PUBLICATION);
    state.status = 'created';
    state.value = value as Value;
    (receiver as CsObject).native = state;
    return;
  },
  'System.Lazy`1.get_IsValueCreated': (_call, receiver) => stateOf<LazyState>(receiver).status === 'created',
  'System.Lazy`1.get_Value': (call, receiver) => valueOf(call, stateOf<LazyState>(receiver)),
  'System.Lazy`1.ToString': (call, receiver) => {
    const state = stateOf<LazyState>(receiver);
    if (state.status !== 'created') return 'Value is not created.';
    const type = typeArgument(call);
    // .NET calls the value's ToString, which a null reference cannot have.
    if (state.value === undefined && isReferenceType(type)) nullReference();
    return textOf(call, state.value, type);
  },
});

function valueOf(call: NativeCall, state: LazyState): Value {
  if (state.status === 'created') return state.value;
  if (state.status === 'failed') throw state.failure;
  if (state.status === 'creating' && state.mode !== PUBLICATION_ONLY)
    fail('System.InvalidOperationException', 'ValueFactory attempted to access the Value property of this instance.');
  state.status = 'creating';
  try {
    const value =
      state.factory === undefined
        ? construct(call)
        : evaluatorOf(call).invokeDelegate(call.frame, state.factory, [], call.row);
    if (!state.isCreated) {
      state.value = value;
      state.status = 'created';
    }
    return state.value;
  } catch (error) {
    if (state.isCreated) throw error;
    const thrown = error instanceof PendingException ? new CsThrow(call.frame.runtime.materialize(error)) : error;
    if (state.factory !== undefined && state.mode !== PUBLICATION_ONLY && thrown instanceof CsThrow) {
      state.status = 'failed';
      state.failure = thrown;
    } else {
      state.status = 'pending';
    }
    throw thrown;
  }
}

/** T made by its public parameterless constructor, as `Activator.CreateInstance<T>` makes it. */
function construct(call: NativeCall): Value {
  const type = typeArgument(call);
  const evaluator = evaluatorOf(call);
  if (type.kind !== 'named') return missing();
  const constructor = type.symbol.constructors.find(
    (candidate) => candidate.parameters.length === 0 && candidate.access === 'public' && !candidate.isStatic
  );
  if (type.symbol.isValueType && !constructor) return evaluator.defaultOf(type);
  if (!constructor || type.symbol.isAbstract) return missing();
  call.frame.runtime.ensureInitialized(type);
  const object = type.symbol.isValueType ? evaluator.defaultOf(type) : evaluator.allocate(type);
  try {
    const result = evaluator.invoke(call.frame, constructor, object, [], call.row, substitutionOf(type as NamedType));
    return constructor.native && result !== undefined ? result : object;
  } catch (error) {
    if (!(error instanceof CsThrow) && !(error instanceof PendingException)) throw error;
    const inner = error instanceof CsThrow ? error.exception : call.frame.runtime.materialize(error);
    throw new CsThrow(
      call.frame.runtime.createException(
        'System.Reflection.TargetInvocationException',
        'Exception has been thrown by the target of an invocation.',
        inner
      )
    );
  }
}

function missing(): never {
  return fail(
    'System.MissingMemberException',
    'The lazily-initialized type does not have a public, parameterless constructor.'
  );
}
