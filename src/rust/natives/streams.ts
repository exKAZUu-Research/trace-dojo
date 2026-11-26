import { type BuiltinAdt, outputStream } from '../types';
import { decodeUtf8 } from '../utf8';
import { sliceItems, type SliceView, StructValue, UNIT_VALUE, type Value } from '../values';
import { writesFile, writeToStream } from './io';
import { define, deref, err, type NativeContext, ok } from './support';

define({
  'std::io::stdout': (_args, ctx) => handle(ctx, 'Stdout'),
  'std::io::stderr': (_args, ctx) => handle(ctx, 'Stderr'),
  'Stdout::lock': (_args, ctx) => handle(ctx, 'StdoutLock'),
  'Stderr::lock': (_args, ctx) => handle(ctx, 'StderrLock'),
  'std::io::Write::write': ([target, bytes], ctx) =>
    write(ctx, bytes, target, BigInt(sliceItems(deref(bytes) as Value[] | SliceView).length)),
  'std::io::Write::write_all': ([target, bytes], ctx) => write(ctx, bytes, target, UNIT_VALUE),
  'std::io::Write::flush': (_args, ctx) => ok(ctx, UNIT_VALUE),
});

function handle(ctx: NativeContext, type: BuiltinAdt): StructValue {
  return new StructValue(ctx.interp.program.adtDef(type), [UNIT_VALUE]);
}

/** Writes bytes to a file or an output stream, giving `Ok(written)` or the `Err` of a file opened only for reading. */
function write(ctx: NativeContext, input: Value, target: Value, written: Value): Value {
  const bytes = sliceItems(deref(input) as Value[] | SliceView);
  ctx.runtime.allocateString(bytes.length);
  if (writesFile(ctx.typeArgs[0])) {
    const error = writeToStream(
      ctx.interp.program,
      target,
      decodeUtf8(Uint8Array.from(bytes, (byte) => Number(byte as bigint)))
    );
    return error ? err(ctx, error) : ok(ctx, written);
  }
  const stream = outputStream(ctx.typeArgs[0]);
  if (!stream) throw new Error('Expected an output stream');
  ctx.runtime.writeBytes(
    stream,
    Uint8Array.from(bytes, (byte) => Number(byte as bigint))
  );
  return ok(ctx, written);
}
