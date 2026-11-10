import { builtin } from '../define';
import { autoClass, enumClass, intEnumClass, newAuto } from '../enums';
import { registerModule } from '../modules';
import type { PyValue } from '../values';

registerModule(
  'enum',
  () =>
    new Map<string, PyValue>([
      ['Enum', enumClass],
      ['IntEnum', intEnumClass],
      ['auto', autoClass],
    ])
);

autoClass.construct = () => newAuto();
void builtin;
