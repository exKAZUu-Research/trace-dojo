import { CompileError } from '../interpreter/diagnostics';

/** Rejects a feature that the interpreter leaves out, before the program runs. */
export function unsupported(row: number, feature: string): never {
  throw new CompileError([{ row, message: unsupportedMessage(feature) }]);
}

export function unsupportedMessage(feature: string): string {
  return `${feature}は、この採点環境では使えません。`;
}
