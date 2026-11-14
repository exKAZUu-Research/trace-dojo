import { PyBytes, PyMemoryView } from './bytesValues';
import { isCContiguous, viewOf } from './memoryview';
import { bindValue, callValue, lookupSpecial } from './objects';
import { currentRuntime } from './runtimeContext';
import { None, typeError, typeName, unbox } from './types';
import { reportUnraisable } from './unraisable';
import { PyError, type PyValue } from './values';

interface BufferArgument {
  name: string;
  position?: number;
}

const encoder = new TextEncoder();

interface WritableBuffer {
  view: PyMemoryView;
  owner?: PyValue;
  original?: PyMemoryView;
}

export function withWritableBuffer(
  value: PyValue,
  argument: BufferArgument,
  run: (view: PyMemoryView) => PyValue
): PyValue {
  const lease = acquireWritableBuffer(value, argument);
  let aborted = false;
  try {
    const result = run(lease.view);
    currentRuntime().handToNative(result);
    return result;
  } catch (error) {
    aborted = !(error instanceof PyError);
    throw error;
  } finally {
    lease.view.release();
    if (!aborted) releaseWritableBuffer(lease);
  }
}

function acquireWritableBuffer(value: PyValue, { name, position }: BufferArgument): WritableBuffer {
  let view: PyMemoryView | undefined;
  try {
    const native = value instanceof PyMemoryView || unbox(value) instanceof PyBytes;
    const original = native ? undefined : callBuffer(value);
    view = viewOf(original ?? value);
    if (view.readonly || !isCContiguous(view)) throw typeError('invalid writable buffer');
    return { view, owner: native ? undefined : value, original };
  } catch (error) {
    view?.release();
    if (!(error instanceof PyError)) throw error;
    const actual = value === None ? 'None' : typeName(value);
    const { read } = encoder.encodeInto(actual, new Uint8Array(50));
    const label = position === undefined ? 'argument' : `argument ${position}`;
    throw typeError(`${name}() ${label} must be read-write bytes-like object, not ${actual.slice(0, read)}`);
  }
}

function callBuffer(value: PyValue): PyMemoryView {
  const buffer = lookupSpecial(value, '__buffer__');
  if (buffer === undefined) throw typeError('object has no buffer');
  const view = callValue(bindValue(buffer, value), [1n]);
  if (!(view instanceof PyMemoryView)) throw typeError('buffer is not a memoryview');
  currentRuntime().handToNative(view);
  return view;
}

function releaseWritableBuffer({ owner, original }: WritableBuffer): void {
  if (owner === undefined || original === undefined) return;
  const release = lookupSpecial(owner, '__release_buffer__');
  if (release === undefined) return;
  try {
    callValue(bindValue(release, owner), [original]);
  } catch (error) {
    if (!(error instanceof PyError)) throw error;
    reportUnraisable(error, `Exception ignored in __release_buffer__ of ${typeName(owner)}`);
  }
}
