import { encodeRune, RUNE_ERROR } from '../literals';
import { type Type } from '../types';
import type { Value } from '../values';
import { marshalEncode } from './jsonArshal';
import { MARSHALER } from './jsonArshalCore';
import { marshalErrorToGo } from './jsonErrors';
import { EncoderState } from './jsonText';
import { formatJSONFloat } from './jsonWire';
import { implementsInterface } from './reflection';
import { errorText } from './support';

/** An error of encoding/json's Marshal, with Go's message, which slog's JSONHandler reports instead of the value. */
export class JsonError extends Error {}

/** Whether `type` provides MarshalJSON, as json.Marshaler. */
export function isJsonMarshaler(type: Type): boolean {
  return implementsInterface(type, MARSHALER);
}

/** `json.Marshal(value)` with HTML escaping off, as slog's JSONHandler encodes values of kind Any. */
export function marshalJson(value: Value): string {
  const enc = new EncoderState({ escapeHTML: false, escapeJS: true, multiline: false, indent: '', prefix: '' });
  const err = marshalEncode(enc, value);
  if (err) throw new JsonError(errorText(marshalErrorToGo(err)));
  return enc.buf;
}

/** encoding/json's encoding of a float. */
export function encodeFloat(f: number, bits: 32 | 64): string {
  if (!Number.isFinite(f)) {
    throw new JsonError(`json: unsupported value: ${Number.isNaN(f) ? 'NaN' : f > 0 ? '+Inf' : '-Inf'}`);
  }
  return formatJSONFloat(f, bits);
}

/** U+FFFD as UTF-8 bytes. */
export const REPLACEMENT_CHARACTER = encodeRune(RUNE_ERROR);
