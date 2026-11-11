// `time.struct_time`, a tuple of nine fields with `tm_zone` and `tm_gmtoff` as attributes outside the tuple.
import { pyRepr } from '../conversions';
import { method } from '../define';
import { toArray } from '../objects';
import { builtinFunctionClass, None, propertyClass, tupleClass, typeClass, typeError } from '../types';
import { PyBuiltinFunction, PyClass, PyDescriptor, PyTuple, type PyValue } from '../values';

const FIELDS = ['tm_year', 'tm_mon', 'tm_mday', 'tm_hour', 'tm_min', 'tm_sec', 'tm_wday', 'tm_yday', 'tm_isdst'];

export class PyStructTime extends PyTuple {
  constructor(
    items: readonly PyValue[],
    readonly zone: PyValue = None,
    readonly gmtoff: PyValue = None
  ) {
    super(structTimeClass, items);
  }
}

export const structTimeClass = new PyClass('struct_time', [tupleClass], typeClass);
structTimeClass.mro = [structTimeClass, ...tupleClass.mro];
structTimeClass.module = 'time';
structTimeClass.typeName = 'time.struct_time';
structTimeClass.construct = (_cls, args) => {
  if (args.length !== 1) throw typeError(`structseq() takes at most 2 arguments (${args.length} given)`);
  const items = toArray(args[0]);
  if (items.length < 9) {
    throw typeError(`time.struct_time() takes an at least 9-sequence (${items.length}-sequence given)`);
  }
  if (items.length > 11) {
    throw typeError(`time.struct_time() takes an at most 11-sequence (${items.length}-sequence given)`);
  }
  return new PyStructTime(items.slice(0, 9), items[9] ?? None, items[10] ?? None);
};

for (const [index, name] of FIELDS.entries()) {
  structTimeClass.dict.set(
    name,
    new PyDescriptor(
      propertyClass,
      new PyBuiltinFunction(builtinFunctionClass, name, ([self]) => (self as PyStructTime).items[index])
    )
  );
}
for (const name of ['tm_zone', 'tm_gmtoff'] as const) {
  structTimeClass.dict.set(
    name,
    new PyDescriptor(
      propertyClass,
      new PyBuiltinFunction(builtinFunctionClass, name, ([self]) =>
        name === 'tm_zone' ? (self as PyStructTime).zone : (self as PyStructTime).gmtoff
      )
    )
  );
}
structTimeClass.dict.set('n_fields', 11n);
structTimeClass.dict.set('n_sequence_fields', 9n);
structTimeClass.dict.set('n_unnamed_fields', 0n);
method(structTimeClass, '__repr__', 'none', 0, 0, (self) => {
  const items = (self as PyStructTime).items;
  return `time.struct_time(${FIELDS.map((name, index) => `${name}=${pyRepr(items[index])}`).join(', ')})`;
});
