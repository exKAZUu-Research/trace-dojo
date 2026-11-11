import { defineNew } from '../instances';
import { registerModule } from '../modules';
import type { PyValue } from '../values';
import { MAXYEAR, MINYEAR } from './calendarMath';
import './datetimeDate';
import './datetimeDateTime';
import { timedeltaClass } from './datetimeDelta';
import { dateClass, datetimeTypeClass, timeClass } from './datetimeObjects';
import './datetimeTime';
import { timezoneClass, tzinfoClass, UTC } from './datetimeZone';

// Subclasses of the classes create their instances through `__new__`, as `super().__new__(cls, ...)` does.
for (const cls of [timedeltaClass, dateClass, datetimeTypeClass, timeClass, tzinfoClass]) {
  const create = cls.construct;
  if (create) defineNew(cls, create);
}

registerModule(
  'datetime',
  () =>
    new Map<string, PyValue>([
      ['MINYEAR', BigInt(MINYEAR)],
      ['MAXYEAR', BigInt(MAXYEAR)],
      ['UTC', UTC],
      ['date', dateClass],
      ['datetime', datetimeTypeClass],
      ['time', timeClass],
      ['timedelta', timedeltaClass],
      ['timezone', timezoneClass],
      ['tzinfo', tzinfoClass],
    ])
);
