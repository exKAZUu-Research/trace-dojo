import { type BuiltinAdt, outputStream } from '../types';
import { sliceItems, type SliceView, StructValue, UNIT_VALUE, type Value } from '../values';
import { define, deref, type NativeContext, ok } from './support';

define({
  'std::io::stdout': (_args, ctx) => handle(ctx, 'Stdout'),
  'std::io::stderr': (_args, ctx) => handle(ctx, 'Stderr'),
  'Stdout::lock': (_args, ctx) => handle(ctx, 'StdoutLock'),
  'Stderr::lock': (_args, ctx) => handle(ctx, 'StderrLock'),
  'std::io::Write::write': ([, bytes], ctx) => ok(ctx, BigInt(write(ctx, bytes))),
  'std::io::Write::write_all': ([, bytes], ctx) => {
    write(ctx, bytes);
    return ok(ctx, UNIT_VALUE);
  },
  'std::io::Write::flush': (_args, ctx) => ok(ctx, UNIT_VALUE),
});

function handle(ctx: NativeContext, type: BuiltinAdt): StructValue {
  return new StructValue(ctx.interp.program.adtDef(type), [UNIT_VALUE]);
}

function write(ctx: NativeContext, input: Value): number {
  const bytes = sliceItems(deref(input) as Value[] | SliceView);
  ctx.runtime.allocateString(bytes.length);
  const stream = outputStream(ctx.typeArgs[0]);
  if (!stream) throw new Error('Expected an output stream');
  ctx.runtime.writeBytes(
    stream,
    Uint8Array.from(bytes, (byte) => Number(byte as bigint))
  );
  return bytes.length;
}
