import { builtin } from '../define';
import {
  autoClass,
  enumClass,
  enumTypeClass,
  flagClass,
  globalEnum,
  intEnumClass,
  intFlagClass,
  memberClass,
  newAuto,
  nonmemberClass,
  reprEnumClass,
  strEnumClass,
  uniqueEnum,
} from '../enums';
import { registerModule, registerUnsupportedAttributes } from '../modules';
import { PyOpaque, type PyValue } from '../values';

autoClass.construct = () => newAuto();
memberClass.construct = (_cls, [value]) => new PyOpaque(memberClass, 'member', value);
nonmemberClass.construct = (_cls, [value]) => new PyOpaque(nonmemberClass, 'nonmember', value);

registerModule(
  'enum',
  () =>
    new Map<string, PyValue>([
      ['EnumType', enumTypeClass],
      ['EnumMeta', enumTypeClass],
      ['Enum', enumClass],
      ['ReprEnum', reprEnumClass],
      ['IntEnum', intEnumClass],
      ['StrEnum', strEnumClass],
      ['Flag', flagClass],
      ['IntFlag', intFlagClass],
      ['auto', autoClass],
      ['member', memberClass],
      ['nonmember', nonmemberClass],
      ['unique', builtin('unique', 'one', 1, 1, ([cls]) => uniqueEnum(cls))],
      ['global_enum', builtin('global_enum', 'one', 1, 1, ([cls]) => globalEnum(cls))],
    ])
);

const BOUNDARY = 'Flag の範囲外の値の扱い（enum.FlagBoundary）';
const CHECK = '列挙型の検査（enum.verify と enum.EnumCheck）';
registerUnsupportedAttributes('enum', {
  verify: CHECK,
  EnumCheck: CHECK,
  UNIQUE: CHECK,
  CONTINUOUS: CHECK,
  NAMED_FLAGS: CHECK,
  FlagBoundary: BOUNDARY,
  STRICT: BOUNDARY,
  CONFORM: BOUNDARY,
  EJECT: BOUNDARY,
  KEEP: BOUNDARY,
  property: 'enum.property',
  show_flag_values: 'enum.show_flag_values',
  pickle_by_enum_name: 'enum.pickle_by_enum_name',
  pickle_by_global_name: 'enum.pickle_by_global_name',
  EnumDict: 'enum.EnumDict',
});
