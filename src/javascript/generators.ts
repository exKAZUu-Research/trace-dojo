import { DONE } from './iteration';
import type { RealmBuilder } from './realm';
import { iteratorResult, WELL_KNOWN_SYMBOLS } from './realmIterators';
import type { Frame, Runtime } from './runtime';
import { JsObject, JsThrow, toBoolean, type Value } from './values';

/** What resumes a suspended generator body: the method of the generator object called and its argument. */
export interface Resume {
  kind: 'next' | 'throw' | 'return';
  value: Value;
}

/** What an `await` suspends its body with: the value it waits for, which the body's driver settles. */
export class Awaiting {
  constructor(readonly value: Value) {}
}

/** What a sync `yield*` suspends with: the delegate's unfinished result, which `next()` returns as it is. */
export class DelegatedResult {
  constructor(readonly result: JsObject) {}
}

/**
 * Evaluation that may suspend at a `yield`, yielding the value the `yield` yields, at a sync `yield*`, yielding the
 * delegate's result, or at an `await`, yielding what it awaits.
 */
export type Steps<T> = Generator<Suspension, T, Resume>;

export type Suspension = Value | Awaiting | DelegatedResult;

/** What resuming a generator gives: a value and whether the body ended, or the result a `yield*` passes through. */
type GeneratorStep = { value: Value; done: boolean } | { delegated: JsObject };

/** The return value of a generator body: the value of its `return` statement, if one ended it. */
export type BodyResult = { kind: string; value?: Value } | undefined;

export interface GeneratorState {
  /** The frame of the body, which every resumption pushes again. */
  frame: Frame;
  body: Steps<BodyResult>;
  status: 'suspendedStart' | 'suspendedYield' | 'executing' | 'completed';
}

/** Thrown at a suspended `yield` by `return()`, which ends the body as a `return` statement there would. */
export class GeneratorReturn {
  constructor(readonly value: Value) {}
}

/** Runs evaluation that is known not to yield, which is everything outside generator bodies. */
export function runToEnd<T>(steps: Steps<T>): T {
  const result = steps.next();
  if (!result.done) throw new Error('A yield ran outside a generator body');
  return result.value;
}

/** Continues a `yield` with what resumed it: `next(value)` gives the value, `throw` and `return` complete abruptly. */
export function resumedValue(resume: Resume): Value {
  if (resume.kind === 'throw') throw new JsThrow(resume.value);
  if (resume.kind === 'return') throw new GeneratorReturn(resume.value);
  return resume.value;
}

/** Creates a generator object, whose body starts at its first `next()`. */
export function createGeneratorObject(
  runtime: Runtime,
  prototype: Value,
  frame: Frame,
  body: Steps<BodyResult>
): JsObject {
  const object = runtime.newObject(prototype instanceof JsObject ? prototype : runtime.realm.generatorPrototype);
  object.generator = { frame, body, status: 'suspendedStart' };
  object.hostIterator = {
    next: () => {
      const step = resumeGenerator(runtime, object, { kind: 'next', value: undefined });
      if ('delegated' in step) {
        const { delegated } = step;
        return toBoolean(runtime.get(delegated, 'done')) ? DONE : runtime.get(delegated, 'value');
      }
      return step.done ? DONE : step.value;
    },
    close: () => {
      resumeGenerator(runtime, object, { kind: 'return', value: undefined });
    },
  };
  return object;
}

/** Resumes a generator as its `next`, `throw`, or `return` method does. */
export function resumeGenerator(runtime: Runtime, object: JsObject, resume: Resume): GeneratorStep {
  const state = object.generator;
  if (!state)
    return runtime.throwError('TypeError', `next method called on incompatible receiver ${runtime.describe(object)}`);
  if (state.status === 'executing') return runtime.throwError('TypeError', 'Generator is already running');
  if (state.status === 'suspendedStart' && resume.kind !== 'next') state.status = 'completed';
  if (state.status === 'completed') {
    if (resume.kind === 'throw') throw new JsThrow(resume.value);
    return { value: resume.kind === 'return' ? resume.value : undefined, done: true };
  }
  state.status = 'executing';
  runtime.resumeFrame(state.frame);
  let result: IteratorResult<Suspension, BodyResult>;
  try {
    result = state.body.next(resume);
  } catch (error) {
    state.status = 'completed';
    if (error instanceof GeneratorReturn) return { value: error.value, done: true };
    throw error;
  } finally {
    runtime.popFrame();
  }
  if (result.done) {
    state.status = 'completed';
    return { value: result.value?.kind === 'return' ? result.value.value : undefined, done: true };
  }
  state.status = 'suspendedYield';
  if (result.value instanceof Awaiting) throw new Error('An await ran in a generator that is not async');
  if (result.value instanceof DelegatedResult) return { delegated: result.value.result };
  return { value: result.value, done: false };
}

/** Defines `%GeneratorPrototype%`, the parent of every generator function's `prototype`. */
export function defineGeneratorBuiltins(builder: RealmBuilder): void {
  const { generatorPrototype } = builder.realm;
  builder.constant(generatorPrototype, WELL_KNOWN_SYMBOLS.toStringTag, 'Generator');
  for (const kind of ['next', 'return', 'throw'] as const) {
    const method = builder.method(generatorPrototype, kind, 1, ({ runtime, thisValue, args }) => {
      if (!(thisValue instanceof JsObject) || !thisValue.generator) {
        return runtime.throwError(
          'TypeError',
          `${kind} method called on incompatible receiver ${runtime.describe(thisValue)}`
        );
      }
      const step = resumeGenerator(runtime, thisValue, { kind, value: args[0] });
      return 'delegated' in step ? step.delegated : iteratorResult(runtime, step.value, step.done);
    });
    builder.realm.hostIteratorMethods.add(method);
  }
}
