import { type BuiltinAdt, outputStream } from '../types';
import { type BufferedWriter, sliceItems, type SliceView, StructValue, UNIT_VALUE, type Value } from '../values';
import { writeTarget, writeToStream, writtenText } from './io';
import { define, deref, err, type NativeContext, ok } from './support';

define({
  'std::io::stdout': (_args, ctx) => handle(ctx, 'Stdout'),
  'std::io::stderr': (_args, ctx) => handle(ctx, 'Stderr'),
  'Stdout::lock': (_args, ctx) => handle(ctx, 'StdoutLock'),
  'Stderr::lock': (_args, ctx) => handle(ctx, 'StderrLock'),
  'std::io::Write::write': ([target, bytes], ctx) =>
    write(ctx, bytes, target, BigInt(sliceItems(deref(bytes) as Value[] | SliceView).length)),
  'std::io::Write::write_all': ([target, bytes], ctx) => write(ctx, bytes, target, UNIT_VALUE),
  'std::io::Write::flush': ([target], ctx) => {
    const error = writeTarget(ctx.typeArgs[0]) === 'buffered' ? (deref(target) as BufferedWriter).flush() : undefined;
    return error ? err(ctx, error) : ok(ctx, UNIT_VALUE);
  },
});

function handle(ctx: NativeContext, type: BuiltinAdt): StructValue {
  return new StructValue(ctx.interp.program.adtDef(type), [UNIT_VALUE]);
}

/** Writes bytes to a file or an output stream, giving `Ok(written)` or the `Err` of a file opened only for reading. */
function write(ctx: NativeContext, input: Value, target: Value, written: Value): Value {
  const bytes = sliceItems(deref(input) as Value[] | SliceView);
  ctx.runtime.allocateString(bytes.length);
  const kind = writeTarget(ctx.typeArgs[0]);
  if (kind) {
    const text = writtenText(bytes, ctx.span);
    const error =
      kind === 'buffered' ? (deref(target) as BufferedWriter).write(text) : writeToStream(target, text, ctx.span);
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
