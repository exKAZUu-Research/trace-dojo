import { callMethod, runToEnd } from './interp';
import { type RObject, RString } from './objects';
import { RubyError } from './runtime';
import { realClassOf } from './values';

/**
 * Describes an exception that ended the program as the first line Ruby prints for it, without the location: the
 * message and the class in parentheses, with the message's later lines after.
 */
export function describeException(exception: RObject): string {
  const name = realClassOf(exception).name ?? '';
  let message: string;
  try {
    const result = runToEnd(callMethod(exception, 'message', []));
    if (!(result instanceof RString)) return name;
    message = result.s;
  } catch (error) {
    if (error instanceof RubyError) return name;
    throw error;
  }
  if (message === '') return name;
  const [first, ...rest] = message.split('\n');
  return [`${first} (${name})`, ...rest].join('\n');
}
