import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test('ISO datetimes consume exactly one Unicode separator in every supported date form', () => {
  const program = String.raw`from datetime import datetime
for date in ['2026-11-13', '20261113', '2026-W46-5', '2026W465']:
    for separator in ['T', ' ', '\u00a0', '\u202f', '\u2009', '\U0001f98a', '\uffff', '\ud800']:
        value = datetime.fromisoformat(date + separator + '12:34:56.123456+09:00')
        assert value.isoformat() == '2026-11-13T12:34:56.123456+09:00'
        for extra in ['T', '\uffff', '\u00a0']:
            try: datetime.fromisoformat(date + separator + extra + '12:34:56')
            except ValueError: pass
            else: raise AssertionError('accepted two separators')
print('parsed')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'parsed\n',
    uncaughtException: undefined,
  });
});

test('fixed timezones hash their complete offsets and preserve set iteration order', () => {
  const program = `from datetime import timedelta, timezone
for seconds in [-86399, -3601, -1, 0, 1, 3600, 86399]:
    for micros in [0, 1, 500000, 999999]:
        offset = timedelta(seconds=seconds, microseconds=micros)
        if abs(offset) < timedelta(days=1):
            assert hash(timezone(offset)) == hash(offset)
            assert hash(timezone(offset, 'named')) == hash(offset)
print([str(zone) for zone in {timezone(timedelta(hours=h)) for h in [0, 1, 2, 3]}])`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: "['UTC+03:00', 'UTC', 'UTC+01:00', 'UTC+02:00']\n",
    uncaughtException: undefined,
  });
});

test('timestamp constructors use numeric subclass values without conversion overrides', () => {
  const program = `from datetime import datetime, date
class Integer(int):
    def __int__(self): raise AssertionError('override')
    def __index__(self): raise AssertionError('override')
class Float(float):
    def __float__(self): raise AssertionError('override')
for constructor in [datetime.fromtimestamp, datetime.utcfromtimestamp, date.fromtimestamp]:
    for value in [0, -1, 86400]:
        assert constructor(Integer(value)) == constructor(value)
    for value in [0.0, -0.5, 1.1234565, 86400.0]:
        assert constructor(Float(value)) == constructor(value)
print('converted')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'converted\n',
    uncaughtException: undefined,
  });
});
