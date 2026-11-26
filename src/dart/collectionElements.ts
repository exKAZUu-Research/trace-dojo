import { AwaitRequest } from './awaitSteps';
import type { HashStore } from './hashStore';
import type { Frame } from './runtime';
import type { DartList, DartObject, Value } from './values';

/** Adds an element, or a map entry, to the collection literal being built. */
export type AddElement = ((key: Value, value?: Value) => void) & { target?: DartObject };

/** Runs an element of a collection literal that awaits, adding its values as it goes. */
export type ElementGen = (frame: Frame, add: AddElement) => Generator<AwaitRequest, void, Value>;

/**
 * The element with the variables in `slots` ending once it has run, the same way whether it runs at once or as a
 * generator: a pattern's variables end after the branch that reads them, and a loop's after the loop.
 */
export function endingVariables<T extends ElementCode>(slots: readonly number[], code: T): T {
  if (slots.length === 0) return code;
  const clear = (frame: Frame): void => {
    for (const slot of slots) frame.locals[slot] = undefined;
  };
  const { run, gen } = code;
  return {
    ...code,
    run: (frame: Frame, add: AddElement) => {
      try {
        run(frame, add);
      } finally {
        clear(frame);
      }
    },
    gen:
      gen &&
      function* (frame: Frame, add: AddElement) {
        try {
          yield* gen(frame, add);
        } finally {
          clear(frame);
        }
      },
  };
}

/** A compiled element of a collection literal, with a generator when it awaits. */
export interface ElementCode {
  run: (frame: Frame, add: AddElement) => void;
  gen?: ElementGen;
}

export function* runElement(code: ElementCode, frame: Frame, add: AddElement): Generator<AwaitRequest, void, Value> {
  if (code.gen) yield* code.gen(frame, add);
  else code.run(frame, add);
}

export function addToList(list: DartObject): AddElement {
  return (value) => {
    (list as DartList).elements.push(value);
  };
}

/** The add of a set or map, whose store keeps a set's elements as keys without values. */
export function addToHashed(collection: DartObject): AddElement {
  const store = collection.native as HashStore;
  return Object.assign((key: Value, value?: Value) => store.set(key, value), { target: collection });
}

/** Builds a collection literal: at once, or through its elements' generator when they await. */
export function building(
  create: (frame: Frame) => DartObject,
  addTo: (collection: DartObject) => AddElement,
  elements: ElementCode,
  built?: (frame: Frame, collection: DartObject) => void
): { run: (frame: Frame) => DartObject; gen: ((frame: Frame) => Generator<AwaitRequest, Value, Value>) | undefined } {
  const { run, gen } = elements;
  return {
    run: (frame) => {
      const collection = create(frame);
      // The elements built so far stay reachable while later ones are evaluated.
      frame.temporaries.push(collection);
      try {
        run(frame, addTo(collection));
      } finally {
        frame.temporaries.pop();
      }
      built?.(frame, collection);
      return collection;
    },
    gen:
      gen &&
      function* (frame) {
        const collection = create(frame);
        frame.temporaries.push(collection);
        try {
          yield* gen(frame, addTo(collection));
        } finally {
          const index = frame.temporaries.lastIndexOf(collection);
          if (index !== -1) frame.temporaries.splice(index, 1);
        }
        built?.(frame, collection);
        return collection;
      },
  };
}

/** Awaits `moveNext` of an `await for` element's StreamIterator. */
export function* awaitMoveNext(frame: Frame, iterator: Value): Generator<AwaitRequest, Value, Value> {
  return yield new AwaitRequest(
    frame.runtime.invoke(iterator, 'moveNext', { positional: [], named: undefined }, [], undefined)
  );
}
