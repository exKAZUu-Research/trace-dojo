// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { setGeneratorFactory } from './calls';
import { throwError } from './errors';
import { GeneratorState } from './generators';
import { defineClass } from './native';
import { nativeDebugInfoMethod } from './output';
import { rt } from './runtime';
import { nativeOwnershipChanged, type PhpClass, type PhpObject } from './values';

function stateOf(object: PhpObject): GeneratorState {
  return object.internal as GeneratorState;
}

defineClass({
  name: 'Generator',
  isFinal: true,
  isCloneable: false,
  interfaces: ['Iterator', 'Traversable'],
  createInternal: () =>
    throwError('Error', 'The "Generator" class is reserved for internal use and cannot be manually instantiated'),
  methods: [
    {
      signature: 'rewind(): void',
      impl: ({ thisObj }) => {
        stateOf(thisObj).rewind();
        return null;
      },
    },
    { signature: 'valid(): bool', impl: ({ thisObj }) => stateOf(thisObj).valid() },
    { signature: 'current(): mixed', impl: ({ thisObj }) => stateOf(thisObj).current() },
    { signature: 'key(): mixed', impl: ({ thisObj }) => stateOf(thisObj).currentKey() },
    {
      signature: 'next(): void',
      impl: ({ thisObj }) => {
        stateOf(thisObj).next();
        return null;
      },
    },
    { signature: 'send(mixed $value): mixed', impl: ({ thisObj, args }) => stateOf(thisObj).send(args[0]) },
    {
      signature: 'throw(Throwable $exception): mixed',
      impl: ({ thisObj, args }) => stateOf(thisObj).throwInto(args[0] as PhpObject),
    },
    { signature: 'getReturn(): mixed', impl: ({ thisObj }) => stateOf(thisObj).getReturn() },
    nativeDebugInfoMethod,
  ],
});

setGeneratorFactory((frame, record) => {
  const runtime = rt();
  const object = runtime.newObject(runtime.classes.get('generator') as PhpClass);
  // The object belongs to the caller, which receives it once the call returns.
  frame.temporaries.splice(frame.temporaries.indexOf(object), 1);
  object.internal = new GeneratorState(object, frame, record);
  nativeOwnershipChanged(object);
  return object;
});
