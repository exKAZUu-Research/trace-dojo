import { defineAttribute } from '../attributeDescriptors';
import { method } from '../define';
import { toIndex } from '../numbers';
import { callValue, getAttribute, isTruthy } from '../objects';
import { currentRuntime } from '../runtimeContext';
import { codePointOffset, strLength } from '../strings';
import { None, pyError, valueError } from '../types';
import { type PyClass, PyFunction, type PyInstance, PyList, type PyValue } from '../values';

export function defineTextReadline(cls: PyClass): void {
  const original = cls.dict.get('readline');
  if (!(original instanceof PyFunction)) return;
  defineAttribute(cls, '_CHUNK_SIZE', (self) => (self as PyInstance).dict.get('_CHUNK_SIZE') ?? 8192n, {
    set: (self, value) => {
      if (value === undefined)
        throw pyError('AttributeError', "attribute '_CHUNK_SIZE' of '_io.TextIOWrapper' objects cannot be deleted");
      const size = toIndex(value);
      if (size < -(1n << 63n) || size >= 1n << 63n) throw valueError("cannot fit 'int' into an index-sized integer");
      if (size <= 0n) throw valueError('a strictly positive integer is required');
      (self as PyInstance).dict.set('_CHUNK_SIZE', size);
    },
  });
  method(cls, 'readline', 'expected', 0, 1, (self, [size]) => {
    const count = size === undefined ? -1n : toIndex(size);
    if (count < -(1n << 63n) || count >= 1n << 63n) {
      throw pyError('OverflowError', 'Python int too large to convert to C ssize_t');
    }
    const line = bufferedLine(self as PyInstance, Number(count));
    const result = line ?? callValue(original, [self, count]);
    if (typeof result === 'string') currentRuntime().spendNative(Math.ceil(result.length / 64));
    return result;
  });
}

function bufferedLine(self: PyInstance, size: number): string | undefined {
  const fields = self.dict;
  const text = fields.get('_decoded_chars');
  const used = fields.get('_decoded_chars_used');
  const pending = fields.get('_pending_bytes');
  if (typeof text !== 'string' || text.length === 0 || typeof used !== 'bigint') return undefined;
  if (!(pending instanceof PyList) || pending.items.length > 0 || fields.get('_decoder') === None) return undefined;
  const start = codePointOffset(text, Number(used));
  const end = lineEnd(text, start, fields);
  const limit = size < 0 ? text.length : codePointOffset(text, Number(used) + size);
  if (end === undefined && (size < 0 || limit === text.length)) return undefined;
  if (isTruthy(getAttribute(self, 'closed'))) throw valueError('I/O operation on closed file.');
  const stop = Math.min(end ?? text.length, limit);
  const result = text.slice(start, stop);
  fields.set('_decoded_chars_used', used + BigInt(strLength(result)));
  return result;
}

function lineEnd(text: string, start: number, fields: Map<string, PyValue>): number | undefined {
  if (!fields.get('_readtranslate') && fields.get('_readuniversal')) {
    const end = text.slice(start).search(/[\r\n]/);
    if (end === -1) return undefined;
    const index = start + end;
    return index + (text.startsWith('\r\n', index) ? 2 : 1);
  }
  const newline = fields.get('_readtranslate') ? '\n' : fields.get('_readnl');
  if (typeof newline !== 'string') return undefined;
  const index = text.indexOf(newline, start);
  return index === -1 ? undefined : index + newline.length;
}
