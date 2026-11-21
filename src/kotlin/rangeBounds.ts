import type { ResolvedCall } from './callCompiler';
import type { Compiled, Eval } from './compilerBase';

export function floatRangeBounds(call: ResolvedCall, receiver: Eval): Compiled['floatRangeBounds'] {
  const { symbol } = call;
  if (!symbol.isLibrary || symbol.packageName !== 'kotlin.ranges' || symbol.name !== 'rangeTo') return undefined;
  const type = symbol.extensionReceiver;
  if (type?.kind !== 'class' || type.cls.kotlinName !== 'kotlin.Float') return undefined;
  return (frame) => [receiver(frame) as number, call.evaluateArgs(frame)[0] as number];
}
