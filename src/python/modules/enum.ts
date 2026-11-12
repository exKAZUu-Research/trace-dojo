import { createDynamicClass } from '../classes';
import { builtin } from '../define';
import {
  enumClass,
  enumTypeClass,
  finishEnumMember,
  inheritIntMethods,
  intEnumClass,
  newEnumMember,
  registerEnumHooks,
  setEnumMembers,
} from '../enums';
import { runLibrarySource } from '../librarySource';
import { mappingProxyClass } from '../mappingProxy';
import { registerModule } from '../modules';
import { toArray } from '../objects';
import { None } from '../types';
import { UnsupportedFeatureError } from '../unsupported';
import { type PyClass, type PyDict, type PyInstance, type PyTuple, type PyValue } from '../values';
import { ENUM_SOURCE } from './enumSource';

inheritIntMethods();

registerModule('enum', () => {
  const namespace = runLibrarySource('enum', ENUM_SOURCE, new Map(nativeHelpers()));
  namespace.set('EnumType', enumTypeClass);
  namespace.set('EnumMeta', enumTypeClass);
  return namespace;
});

function nativeHelpers(): [string, PyValue][] {
  return [
    ['Enum', enumClass],
    ['IntEnum', intEnumClass],
    ['_EnumType', enumTypeClass],
    ['MappingProxyType', mappingProxyClass],
    [
      '_register_enum_hooks',
      builtin('_register_enum_hooks', 'expected', 6, 6, ([prepare, setItem, build, call, contains, methods]) => {
        registerEnumHooks({ prepare, setItem, build, call, contains, methods: methods as PyDict });
        return None;
      }),
    ],
    [
      '_new_member',
      builtin('_new_member', 'expected', 3, 3, ([cls, name, value]) => newEnumMember(cls as PyClass, name, value)),
    ],
    ['_finish_member', builtin('_finish_member', 'one', 1, 1, ([member]) => finishEnumMember(member as PyInstance))],
    [
      '_set_enum_members',
      builtin('_set_enum_members', 'expected', 2, 2, ([cls, members]) => {
        setEnumMembers(cls as PyClass, toArray(members) as PyInstance[]);
        return None;
      }),
    ],
    [
      '_new_class',
      builtin('_new_class', 'expected', 4, 4, ([name, bases, items, module]) => {
        const namespace = new Map(toArray(items).map((item) => (item as PyTuple).items as [string, PyValue]));
        const cls = createDynamicClass(name as string, toArray(bases) as PyClass[], namespace, module as string);
        cls.flags.isEnum = true;
        cls.cls = enumTypeClass;
        return cls;
      }),
    ],
    [
      '_unsupported',
      builtin('_unsupported', 'one', 1, 1, ([feature]) => {
        throw new UnsupportedFeatureError(feature as string);
      }),
    ],
  ];
}
