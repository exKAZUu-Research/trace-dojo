// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { defineClass, type NativeMethod } from './native';

const abstractMethods = (signatures: string[]): NativeMethod[] =>
  signatures.map((signature) => ({ signature, impl: () => null, isAbstract: true }));

defineClass({
  name: 'OuterIterator',
  kind: 'interface',
  interfaces: ['Iterator', 'Traversable'],
  methods: abstractMethods(['getInnerIterator(): ?Iterator']),
});
defineClass({
  name: 'RecursiveIterator',
  kind: 'interface',
  interfaces: ['Iterator', 'Traversable'],
  methods: abstractMethods(['hasChildren(): bool', 'getChildren(): ?RecursiveIterator']),
});
defineClass({
  name: 'SplObserver',
  kind: 'interface',
  methods: abstractMethods(['update(SplSubject $subject): void']),
});
defineClass({
  name: 'SplSubject',
  kind: 'interface',
  methods: abstractMethods([
    'attach(SplObserver $observer): void',
    'detach(SplObserver $observer): void',
    'notify(): void',
  ]),
});
