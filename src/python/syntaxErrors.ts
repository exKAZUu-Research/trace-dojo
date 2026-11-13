// The attributes and the str of SyntaxError, which `SyntaxError(msg, (filename, lineno, offset, text))` sets.
import { pyStr } from './conversions';
import { method } from './define';
import { exceptionClasses, exceptionClassNamed, newTuple, None, stringValue, typeError } from './types';
import { type PyInstance, PyTuple, type PyValue } from './values';

const syntaxErrorClass = exceptionClassNamed('SyntaxError');
const DETAILS = ['filename', 'lineno', 'offset', 'text', 'end_lineno', 'end_offset'];

/** Sets the attributes SyntaxError's constructor takes from its arguments, which its str shows. */
function setDetails(exception: PyInstance, args: readonly PyValue[]): void {
  exception.dict.set('msg', args[0] ?? None);
  for (const name of [...DETAILS, 'print_file_and_line']) exception.dict.set(name, None);
  const info = args[1];
  if (args.length !== 2 || !(info instanceof PyTuple)) return;
  if (info.items.length < 4 || info.items.length > 6) throw typeError('tuple index out of range');
  for (const [index, value] of info.items.entries()) exception.dict.set(DETAILS[index], value);
}

for (const cls of exceptionClasses.values()) {
  if (!cls.isSubclassOf(syntaxErrorClass)) continue;
  const construct = cls.construct;
  if (!construct) continue;
  cls.construct = (target, args, kwargs) => {
    const exception = construct(target, args, kwargs) as PyInstance;
    setDetails(exception, args);
    return exception;
  };
}

method(syntaxErrorClass, '__init__', 'expected', 0, Number.POSITIVE_INFINITY, (self, args) => {
  const exception = self as PyInstance;
  if (exception.exception) exception.exception.args = newTuple(args);
  setDetails(exception, args);
  return None;
});

method(syntaxErrorClass, '__str__', 'none', 0, 0, (self) => {
  const { dict } = self as PyInstance;
  const message = pyStr(dict.get('msg') ?? None);
  const filename = stringValue(dict.get('filename'));
  const lineno = dict.get('lineno');
  const name = typeof filename === 'string' ? filename.split('/').at(-1) : undefined;
  const hasLine = typeof lineno === 'bigint';
  if (name && hasLine) return `${message} (${name}, line ${lineno})`;
  if (name) return `${message} (${name})`;
  if (hasLine) return `${message} (line ${lineno})`;
  return message;
});
