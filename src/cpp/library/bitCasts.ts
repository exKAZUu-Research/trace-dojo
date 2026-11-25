import { DOUBLE, FLOAT, type FunctionInfo, UINT, ULLONG } from '../types';
import { native } from './support';

/** The natives `std::bit_cast` reads and writes the bits of floating-point numbers with. */
export function bitCastFunctions(): Map<string, FunctionInfo[]> {
  const view = new DataView(new ArrayBuffer(8));
  return new Map([
    [
      '__builtin_float_bits',
      [
        native('__builtin_float_bits', [FLOAT], UINT, ([value]) => {
          view.setFloat32(0, value as number);
          return view.getUint32(0);
        }),
      ],
    ],
    [
      '__builtin_double_bits',
      [
        native('__builtin_double_bits', [DOUBLE], ULLONG, ([value]) => {
          view.setFloat64(0, value as number);
          return view.getBigUint64(0);
        }),
      ],
    ],
    [
      '__builtin_bits_float',
      [
        native('__builtin_bits_float', [UINT], FLOAT, ([bits]) => {
          view.setUint32(0, Number(bits));
          return view.getFloat32(0);
        }),
      ],
    ],
    [
      '__builtin_bits_double',
      [
        native('__builtin_bits_double', [ULLONG], DOUBLE, ([bits]) => {
          view.setBigUint64(0, BigInt(bits as number | bigint));
          return view.getFloat64(0);
        }),
      ],
    ],
  ]);
}
