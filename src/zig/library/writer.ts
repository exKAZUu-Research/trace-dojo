import type { StructType } from '../types';
import { nativeStruct } from './native';

/** `std.Io.Writer`, an interface that buffers bytes until it drains them to its stream; `std.ts` defines its methods. */
export const WRITER: StructType = nativeStruct('Io.Writer', {});
