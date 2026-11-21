export const unaryOperations = {
  acos: 'all',
  acosh: 'narrow',
  asin: 'all',
  asinh: 'narrow',
  atan: 'all',
  atanh: 'narrow',
  cbrt: 'narrow',
  cos: 'all',
  cosh: 'narrow',
  exp: 'all',
  exp2: 'all',
  expm1: 'narrow',
  log: 'all',
  log1p: 'narrow',
  log2: 'all',
  log10: 'all',
  sin: 'all',
  sinh: 'narrow',
  tan: 'all',
  tanh: 'narrow',
} as const;

export const binaryOperations = {
  atan2: 'narrow',
  hypot: 'all',
  logBase: 'narrow',
  pow: 'narrow',
} as const;

export type UnaryOperation = keyof typeof unaryOperations;
export type BinaryOperation = keyof typeof binaryOperations;
