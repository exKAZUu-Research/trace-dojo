import { pyRepr } from '../conversions';
import { builtin } from '../define';
import { getAttributeOrUndefined } from '../objects';
import { registerSourceModule } from '../sourceModules';
import { forwardRefClass, typeRepr } from '../typeHints';
import { newDict, typeError } from '../types';
import { PyDict, type PyValue } from '../values';

// The part of CPython's `annotationlib.py` that annotations evaluated eagerly need: the formats, ForwardRef, and
// get_annotations, which gives the evaluated annotations whatever the format.
const SOURCE = String.raw`
import enum


class Format(enum.IntEnum):
    VALUE = 1
    VALUE_WITH_FAKE_GLOBALS = 2
    FORWARDREF = 3
    STRING = 4


def get_annotations(
    obj, *, globals=None, locals=None, eval_str=False, format=Format.VALUE
):
    if eval_str and format != Format.VALUE:
        raise ValueError("eval_str=True is only supported with format=Format.VALUE")
    if eval_str or globals is not None or locals is not None:
        _unsupported('annotationlib.get_annotations() の eval_str・globals・locals')
    if format == Format.STRING:
        return {key: type_repr(value) for key, value in _annotations_of(obj).items()}
    return _annotations_of(obj)


def type_repr(value):
    if isinstance(value, str):
        return value
    return _type_repr(value)
`;

registerSourceModule(
  'annotationlib',
  SOURCE,
  () =>
    new Map<string, PyValue>([
      ['ForwardRef', forwardRefClass],
      ['_annotations_of', builtin('_annotations_of', 'one', 1, 1, ([obj]) => annotationsOf(obj))],
      ['_type_repr', builtin('_type_repr', 'one', 1, 1, ([value]) => typeRepr(value))],
    ])
);

/** A new dict of the annotations of a class, function, or module, as get_annotations gives them. */
function annotationsOf(obj: PyValue): PyValue {
  const annotations = getAttributeOrUndefined(obj, '__annotations__');
  if (annotations === undefined) throw typeError(`${pyRepr(obj)} does not have annotations`);
  if (!(annotations instanceof PyDict)) return newDict();
  return newDict(annotations.store.ordered().map((entry): [PyValue, PyValue] => [entry.key, entry.value]));
}
