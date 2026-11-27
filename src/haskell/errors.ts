import { CompileError } from '../interpreter/diagnostics';
import type { Span } from './syntax';

export function unsupportedError(span: Span | number, what: string): CompileError {
  return compileError(span, `${what}は、この採点環境では使えません。`);
}

export function compileError(span: Span | number, message: string): CompileError {
  const row = typeof span === 'number' ? span : span.row;
  return new CompileError([{ row, message }]);
}

/** A required type argument written as a term, which GHC maps to a type and this environment does not. */
export const REQUIRED_TYPE_TERM = '型の引数を type を付けずに書く書き方（RequiredTypeArguments）';
