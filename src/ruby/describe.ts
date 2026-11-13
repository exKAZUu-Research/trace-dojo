import { toS } from './conversions';
import { callMethod, runToEnd } from './interp';
import type { RObject } from './objects';
import { realClassOf } from './values';

/**
 * Describes an exception that ended the program as the first line Ruby prints for it, without the location: the
 * message and the class in parentheses, with the message's later lines after.
 */
export function describeException(exception: RObject): string {
  const name = realClassOf(exception).name ?? '';
  const message = runToEnd(toS(runToEnd(callMethod(exception, 'message', []))));
  if (message === "") return name;
  const [first, ...rest] = message.split('\n');
  if (first === name) return [`${first} (${name})`, ...rest].join('\n');
  return [`${first} (${name})`, ...rest].join('\n');
}
