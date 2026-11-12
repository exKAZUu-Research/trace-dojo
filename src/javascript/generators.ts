import { DONE } from './iteration';
import type { RealmBuilder } from './realm';
import { iteratorResult, WELL_KNOWN_SYMBOLS } from './realmIterators';
import type { Frame, Runtime } from './runtime';
import { JsObject, JsThrow, type Value } from './values';

/** What resumes a suspended generator body: the method of the generator object called and its argument. */
export interface Resume {
  kind: 'next' | 'throw' | 'return';
  value: Value;
}

/** Evaluation that may suspend at a generator's `yield`, yielding the value the `yield` yields. */
export type Steps<T> = Generator<Value, T, Resume>;

/** The return value of a generator body: the value of its `return` statement, if one ended it. */
type BodyResult = { kind: string; value?: Value } | undefined;

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
      const result = resumeGenerator(runtime, object, { kind: 'next', value: undefined });
      return result.done ? DONE : result.value;
    },
    close: () => {
      resumeGenerator(runtime, object, { kind: 'return', value: undefined });
    },
  };
  return object;
}

/** Resumes a generator as its `next`, `throw`, or `return` method does. */
export function resumeGenerator(runtime: Runtime, object: JsObject, resume: Resume): { value: Value; done: boolean } {
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
  let result: IteratorResult<Value, BodyResult>;
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
  return { value: result.value, done: false };
}

/** Defines `%GeneratorPrototype%`, the parent of every generator function's `prototype`. */
export function defineGeneratorBuiltins(builder: RealmBuilder): void {
  const { generatorPrototype } = builder.realm;
  builder.constant(generatorPrototype, WELL_KNOWN_SYMBOLS.toStringTag, 'Generator');
  for (const kind of ['next', 'return', 'throw'] as const) {
    builder.method(generatorPrototype, kind, 1, ({ runtime, thisValue, args }) => {
      if (!(thisValue instanceof JsObject) || !thisValue.generator) {
        return runtime.throwError(
          'TypeError',
          `${kind} method called on incompatible receiver ${runtime.describe(thisValue)}`
        );
      }
      const { value, done } = resumeGenerator(runtime, thisValue, { kind, value: args[0] });
      return iteratorResult(runtime, value, done);
    });
  }
}
