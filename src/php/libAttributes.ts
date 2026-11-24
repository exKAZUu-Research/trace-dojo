// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { SENSITIVE_VALUE_KEY } from './attributeEffects';
import { defineClass } from './native';
import { PhpArray } from './values';

defineClass({
  name: 'Attribute',
  isFinal: true,
  consts: {
    TARGET_CLASS: 1n,
    TARGET_FUNCTION: 2n,
    TARGET_METHOD: 4n,
    TARGET_PROPERTY: 8n,
    TARGET_CLASS_CONSTANT: 16n,
    TARGET_PARAMETER: 32n,
    TARGET_CONSTANT: 64n,
    TARGET_ALL: 127n,
    IS_REPEATABLE: 128n,
  },
  props: [{ name: 'flags', visibility: 'public', type: 'int' }],
  methods: [
    {
      signature: '__construct(int $flags = Attribute::TARGET_ALL)',
      impl: ({ thisObj, args }) => {
        thisObj.props.set('flags', args[0] ?? 127n);
        return null;
      },
    },
  ],
});

for (const name of ['ReturnTypeWillChange', 'AllowDynamicProperties', 'SensitiveParameter', 'Override'])
  defineClass({
    name,
    isFinal: true,
    methods: [{ signature: '__construct()', impl: () => null }],
  });

defineClass({ name: 'DelayedTargetValidation', isFinal: true });

defineClass({
  name: 'Deprecated',
  isFinal: true,
  props: [
    { name: 'message', visibility: 'public', type: '?string', isReadonly: true },
    { name: 'since', visibility: 'public', type: '?string', isReadonly: true },
  ],
  methods: [
    {
      signature: '__construct(?string $message = null, ?string $since = null)',
      impl: ({ thisObj, args }) => {
        thisObj.props.set('message', args[0] ?? null);
        thisObj.props.set('since', args[1] ?? null);
        return null;
      },
    },
  ],
});

defineClass({
  name: 'NoDiscard',
  isFinal: true,
  props: [{ name: 'message', visibility: 'public', type: '?string', isReadonly: true }],
  methods: [
    {
      signature: '__construct(?string $message = null)',
      impl: ({ thisObj, args }) => {
        thisObj.props.set('message', args[0] ?? null);
        return null;
      },
    },
  ],
});

defineClass({
  name: 'SensitiveParameterValue',
  isFinal: true,
  props: [{ name: 'value', visibility: 'private', type: 'mixed', isReadonly: true }],
  methods: [
    {
      signature: '__construct(mixed $value)',
      impl: ({ thisObj, args }) => {
        thisObj.props.set(SENSITIVE_VALUE_KEY, args[0]);
        return null;
      },
    },
    { signature: 'getValue(): mixed', impl: ({ thisObj }) => thisObj.props.get(SENSITIVE_VALUE_KEY) as never },
    { signature: '__debugInfo(): array', impl: () => new PhpArray() },
  ],
});
