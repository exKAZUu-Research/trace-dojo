import type { FormattedValue } from './ast';
import { pyRepr } from './conversions';
import { method } from './define';
import { defineNew } from './instances';
import { importModule } from './modules';
import { readOnlyAttribute } from './modules/re/attributes';
import { getAttribute, getIterator } from './objects';
import { currentRuntime } from './runtimeContext';
import { builtinClass, newTuple, None, NotImplemented, pyError, typeError, typeName, unbox } from './types';
import { type Kwargs, PyObject, type PyValue } from './values';

// The types of `string.templatelib` (PEP 750), which CPython writes in C: a t-string literal creates a Template.

export const templateClass = builtinClass('Template');
export const interpolationClass = builtinClass('Interpolation');
for (const cls of [templateClass, interpolationClass]) {
  cls.module = 'string.templatelib';
  cls.typeName = `string.templatelib.${cls.name}`;
}

export class PyInterpolation extends PyObject {
  constructor(
    readonly value: PyValue,
    readonly expression: PyValue,
    readonly conversion: PyValue,
    readonly formatSpec: PyValue
  ) {
    super(interpolationClass);
  }
}

export class PyTemplate extends PyObject {
  /** One more string than interpolations: the text before, between, and after them. */
  constructor(
    readonly strings: readonly PyValue[],
    readonly interpolations: readonly PyInterpolation[]
  ) {
    super(templateClass);
  }
}

/** The value of a t-string literal, from its parts and the value and format spec of each replacement field. */
export function templateLiteral(parts: (string | FormattedValue)[], fields: [PyValue, string][]): PyTemplate {
  const strings: string[] = [];
  const interpolations: PyInterpolation[] = [];
  let text = '';
  for (const part of parts) {
    if (typeof part === 'string') {
      text += part;
      continue;
    }
    const [value, spec] = fields[interpolations.length];
    strings.push(text + (part.debugText ?? ''));
    text = '';
    interpolations.push(new PyInterpolation(value, part.expressionText ?? '', part.conversion ?? None, spec));
  }
  strings.push(text);
  currentRuntime().allocate(strings.length + interpolations.length + 1);
  return new PyTemplate(strings, interpolations);
}

// Template ------------------------------------------------------------------------------------------------------------

defineNew(templateClass, (_cls, args, kwargs) => {
  if (kwargs && kwargs.size > 0) throw typeError('Template.__new__ only accepts *args arguments');
  const strings: PyValue[] = [];
  const interpolations: PyInterpolation[] = [];
  let pending: PyValue[] = [];
  const flush = (): void => {
    // A lone string keeps its type, as CPython concatenates only when there are several.
    strings.push(pending.length === 1 ? pending[0] : pending.map((each) => stringValue(each)).join(''));
    pending = [];
  };
  for (const arg of args) {
    if (isStr(arg)) pending.push(arg);
    else if (arg instanceof PyInterpolation) {
      flush();
      interpolations.push(arg);
    } else {
      throw typeError(`Template.__new__ *args need to be of type 'str' or 'Interpolation', got ${typeName(arg)}`);
    }
  }
  flush();
  currentRuntime().allocate(args.length + 1);
  return new PyTemplate(strings, interpolations);
});

function isStr(value: PyValue): boolean {
  return typeof unbox(value) === 'string';
}

function stringValue(value: PyValue): string {
  return unbox(value) as string;
}

readOnlyAttribute(templateClass, 'strings', 'member', (self) => newTuple([...(self as PyTemplate).strings]));
readOnlyAttribute(templateClass, 'interpolations', 'member', (self) =>
  newTuple([...(self as PyTemplate).interpolations])
);
readOnlyAttribute(templateClass, 'values', 'getset', (self) =>
  newTuple((self as PyTemplate).interpolations.map((each) => each.value))
);
method(templateClass, '__repr__', 'none', 0, 0, (self) => {
  const template = self as PyTemplate;
  return `Template(strings=${pyRepr(newTuple([...template.strings]))}, interpolations=${pyRepr(newTuple([...template.interpolations]))})`;
});
method(templateClass, '__iter__', 'none', 0, 0, (self) => {
  const template = self as PyTemplate;
  const items: PyValue[] = [];
  for (const [index, string] of template.strings.entries()) {
    if (stringValue(string) !== '') items.push(string);
    if (index < template.interpolations.length) items.push(template.interpolations[index]);
  }
  return getIterator(newTuple(items));
});
method(templateClass, '__add__', 'one', 1, 1, (self, [other]) => {
  const template = self as PyTemplate;
  if (other instanceof PyTemplate) {
    const strings = [
      ...template.strings.slice(0, -1),
      stringValue(template.strings.at(-1) as PyValue) + stringValue(other.strings[0]),
      ...other.strings.slice(1),
    ];
    currentRuntime().allocate(strings.length + 1);
    return new PyTemplate(strings, [...template.interpolations, ...other.interpolations]);
  }
  throw typeError(
    `can only concatenate string.templatelib.Template (not "${typeName(other)}") to string.templatelib.Template`
  );
});
method(templateClass, '__radd__', 'one', 1, 1, (_self, [other]) => {
  if (isStr(other)) throw typeError('can only concatenate str (not "string.templatelib.Template") to str');
  return NotImplemented;
});
method(templateClass, '__reduce__', 'none', 0, 0, (self) => {
  const template = self as PyTemplate;
  const unpickle = getAttribute(importModule(currentRuntime(), 'string.templatelib'), '_template_unpickle');
  return newTuple([unpickle, newTuple([newTuple([...template.strings]), newTuple([...template.interpolations])])]);
});

// Interpolation -------------------------------------------------------------------------------------------------------

const INTERPOLATION_PARAMETERS = ['value', 'expression', 'conversion', 'format_spec'];

defineNew(interpolationClass, (_cls, args, kwargs) => {
  const [value, expression, conversion, formatSpec] = interpolationArguments(args, kwargs);
  if (!isStr(expression)) throw argumentTypeError('expression', 'str', expression);
  if (conversion !== None) {
    if (!isStr(conversion)) throw argumentTypeError('conversion', 'str', conversion);
    if (!['s', 'a', 'r'].includes(stringValue(conversion))) {
      throw pyError('ValueError', "Interpolation() argument 'conversion' must be one of 's', 'a' or 'r'");
    }
  }
  if (!isStr(formatSpec)) throw argumentTypeError('format_spec', 'str', formatSpec);
  currentRuntime().allocate(1);
  return new PyInterpolation(value, expression, conversion, formatSpec);
});

/** The arguments of `Interpolation(value, expression='', conversion=None, format_spec='')`, as Argument Clinic parses them. */
function interpolationArguments(args: PyValue[], kwargs: Kwargs): PyValue[] {
  const total = args.length + (kwargs?.size ?? 0);
  if (total > 4) throw typeError(`Interpolation() takes at most 4 arguments (${total} given)`);
  const values: (PyValue | undefined)[] = [...args];
  for (const [key, value] of kwargs ?? []) {
    const index = INTERPOLATION_PARAMETERS.indexOf(key);
    if (index === -1) throw typeError(`Interpolation() got an unexpected keyword argument '${key}'`);
    if (index < args.length) {
      throw typeError(`argument for Interpolation() given by name ('${key}') and position (${index + 1})`);
    }
    values[index] = value;
  }
  if (values[0] === undefined) throw typeError("Interpolation() missing required argument 'value' (pos 1)");
  return [values[0], values[1] ?? '', values[2] ?? None, values[3] ?? ''];
}

function argumentTypeError(name: string, expected: string, value: PyValue): Error {
  return typeError(`Interpolation() argument '${name}' must be ${expected}, not ${typeName(value)}`);
}

for (const [index, name] of INTERPOLATION_PARAMETERS.entries()) {
  readOnlyAttribute(interpolationClass, name, 'member', (self) => interpolationFields(self as PyInterpolation)[index]);
}
interpolationClass.dict.set('__match_args__', newTuple([...INTERPOLATION_PARAMETERS]));
method(interpolationClass, '__repr__', 'none', 0, 0, (self) => {
  const fields = interpolationFields(self as PyInterpolation);
  return `Interpolation(${fields.map((field) => pyRepr(field)).join(', ')})`;
});
method(interpolationClass, '__reduce__', 'none', 0, 0, (self) =>
  newTuple([interpolationClass, newTuple(interpolationFields(self as PyInterpolation))])
);

function interpolationFields(interpolation: PyInterpolation): PyValue[] {
  return [interpolation.value, interpolation.expression, interpolation.conversion, interpolation.formatSpec];
}
