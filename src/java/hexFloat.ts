const HEX_FLOAT = /^([+-]?)0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?[pP]([+-]?\d+)[fFdD]?$/;

/**
 * The double a hexadecimal floating-point literal such as `0x1.8p1` denotes, or `undefined` for other text, as Java
 * reads it in source and in `Double.parseDouble`.
 */
export function parseHexFloat(text: string): number | undefined {
  const match = HEX_FLOAT.exec(text);
  if (!match) return undefined;
  const [, sign, integer = '', fraction = '', exponent = '0'] = match;
  if (integer === '' && fraction === '') return undefined;
  // The mantissa rounds once to a double; the power of two scales it exactly but for overflow and subnormals.
  let value = Number(BigInt(`0x${integer}${fraction}`));
  let scale = Number(exponent) - 4 * fraction.length;
  while (scale > 0 && Number.isFinite(value) && value !== 0) {
    const step = Math.min(scale, 512);
    value *= 2 ** step;
    scale -= step;
  }
  while (scale < 0 && value !== 0) {
    const step = Math.max(scale, -512);
    value *= 2 ** step;
    scale -= step;
  }
  return sign === '-' ? -value : value;
}
