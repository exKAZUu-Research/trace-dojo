import { fma } from './binaryFloat';
import { FLOAT_POWER_EXP, FLOAT_POWER_LOG } from './floatPowerTables';

export function appleFloatPower(x: number, y: number): number {
  if (x === 1 || y === 0 || (x === -1 && !Number.isFinite(y) && !Number.isNaN(y))) return 1;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x === 0 || y === 1) return Math.fround(x ** y);
  if (x < 0 && !Number.isInteger(y)) return Number.NaN;
  const negative = x < 0 && Math.abs(y) % 2 === 1;
  const logarithm = scaledLogarithm(Math.abs(x));
  const scaled = Math.min(32_768, Math.max(-32_768, y * logarithm));
  const integer = Math.sign(scaled) * Math.round(Math.abs(scaled));
  const fraction = scaled - integer;
  const bits = FLOAT_POWER_EXP[integer & 127] + (BigInt(integer) << 45n);
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, bits, true);
  const scale = view.getFloat64(0, true);
  const polynomial = fma(1.4662262378543872e-5, fraction, 0.005415217308896754) * fraction;
  const result = Math.fround(fma(polynomial, scale, scale));
  return negative ? -result : result;
}

function scaledLogarithm(x: number): number {
  const view = new DataView(new ArrayBuffer(4));
  const subnormal = x < 2 ** -126;
  view.setFloat32(0, subnormal ? x * 2 ** 23 : x, true);
  const bits = view.getUint32(0, true);
  const reduced = bits - 0x3f_33_80_00;
  const exponentBits = reduced & 0xff_80_00_00;
  const index = (reduced >>> 16) & 127;
  view.setUint32(0, bits - exponentBits, true);
  const mantissa = view.getFloat32(0, true);
  const [inverse, offset] = FLOAT_POWER_LOG[index];
  const r = fma(mantissa, inverse, -1);
  const high = fma(-46.16680486880053, r, 61.55555197023551);
  const low = fma(-92.33248261492298, r, 184.6649652327124);
  const polynomial = fma(high, r * r, low);
  return fma(polynomial, r, offset + (exponentBits >> 16) - (subnormal ? 23 * 128 : 0));
}
