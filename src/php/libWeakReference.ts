// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { createObject } from './classes';
import { throwError } from './errors';
import { defineClass } from './native';
import { rt, type Runtime } from './runtime';
import type { Key, PhpClass, PhpObject, Value } from './values';

/**
 * The state of a WeakReference. It lists no `held` values, so that garbage collection does not count the reference as
 * a holder of its object, which the runtime then frees as if the reference did not exist.
 */
class WeakReferenceState {
  constructor(readonly target: PhpObject) {}

  get(): PhpObject | null {
    return isAlive(rt(), this.target) ? this.target : null;
  }

  debugEntries(): [Key, Value][] {
    return [['object', this.get()]];
  }
}

function isAlive(runtime: Runtime, object: PhpObject): boolean {
  return runtime.objects.get(object.id) === object;
}

/** The WeakReference of each object, which `WeakReference::create` returns again while it exists. */
const references = new WeakMap<PhpObject, PhpObject>();

defineClass({
  name: 'WeakReference',
  isFinal: true,
  isCloneable: false,
  methods: [
    {
      signature: '__construct()',
      impl: () =>
        throwError('Error', 'Direct instantiation of WeakReference is not allowed, use WeakReference::create instead'),
    },
    {
      signature: 'create(object $object): WeakReference',
      isStatic: true,
      impl: ({ args, calledClass }) => {
        const runtime = rt();
        const target = args[0] as PhpObject;
        const existing = references.get(target);
        if (existing && isAlive(runtime, existing)) return existing;
        const reference = createObject(calledClass as PhpClass);
        reference.internal = new WeakReferenceState(target);
        references.set(target, reference);
        return reference;
      },
    },
    {
      signature: 'get(): ?object',
      impl: ({ thisObj }) => (thisObj.internal as WeakReferenceState).get(),
    },
  ],
});
