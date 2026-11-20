export const FLOAT_LIMITS: Record<string, { f64: number; f32: number }> = {
  MAX: { f64: Number.MAX_VALUE, f32: 3.4028234663852886e38 },
  MIN: { f64: -Number.MAX_VALUE, f32: -3.4028234663852886e38 },
  INFINITY: { f64: Number.POSITIVE_INFINITY, f32: Number.POSITIVE_INFINITY },
  NEG_INFINITY: { f64: Number.NEGATIVE_INFINITY, f32: Number.NEGATIVE_INFINITY },
  NAN: { f64: Number.NaN, f32: Number.NaN },
  EPSILON: { f64: Number.EPSILON, f32: 1.1920928955078125e-7 },
  MIN_POSITIVE: { f64: 2.2250738585072014e-308, f32: 1.1754943508222875e-38 },
};

/** `std::f64::consts`, rounded from the literals that std writes for them where `Math` does not round alike. */
export const F64_CONSTS: Record<string, number> = {
  PI: Math.PI,
  TAU: 2 * Math.PI,
  E: Math.E,
  SQRT_2: Math.SQRT2,
  LN_2: Math.LN2,
  LN_10: Math.LN10,
  FRAC_PI_2: Math.PI / 2,
  FRAC_PI_3: Number('1.04719755119659774615421446109316763'),
  FRAC_PI_4: Math.PI / 4,
  FRAC_PI_6: Number('0.52359877559829887307710723054658381'),
  FRAC_PI_8: Number('0.39269908169872415480783042290993786'),
  FRAC_1_PI: Number('0.318309886183790671537767526745028724'),
  FRAC_2_PI: Number('0.636619772367581343075535053490057448'),
  FRAC_2_SQRT_PI: Number('1.12837916709551257389615890312154517'),
  FRAC_1_SQRT_2: Number('0.707106781186547524400844362104849039'),
  LOG2_E: Number('1.44269504088896340735992468100189214'),
  LOG10_E: Number('0.434294481903251827651128918916605082'),
  LOG2_10: Number('3.32192809488736234787031942948939018'),
  LOG10_2: Number('0.301029995663981195213738894724493027'),
};

export function floatConstant(name: string, width: 'f32' | 'f64'): number | undefined {
  const limit = FLOAT_LIMITS[name]?.[width];
  if (limit !== undefined) return limit;
  const value = F64_CONSTS[name];
  return value === undefined || width === 'f64' ? value : Math.fround(value);
}
