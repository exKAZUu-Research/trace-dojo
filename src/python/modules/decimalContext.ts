/** The rounding modes of the decimal module. */
export const ROUNDINGS = [
  'ROUND_UP',
  'ROUND_DOWN',
  'ROUND_CEILING',
  'ROUND_FLOOR',
  'ROUND_HALF_UP',
  'ROUND_HALF_DOWN',
  'ROUND_HALF_EVEN',
  'ROUND_05UP',
] as const;
export type Rounding = (typeof ROUNDINGS)[number];

/** The signals in the order libmpdec checks them, which decides the class of the exception a trap raises. */
export const SIGNALS = [
  'InvalidOperation',
  'FloatOperation',
  'DivisionByZero',
  'Overflow',
  'Underflow',
  'Subnormal',
  'Inexact',
  'Rounded',
  'Clamped',
] as const;
export type Signal = (typeof SIGNALS)[number];

/** The conditions that signal InvalidOperation, in the order libmpdec lists them. */
export const INVALID_CONDITIONS = [
  'InvalidOperation',
  'ConversionSyntax',
  'DivisionImpossible',
  'DivisionUndefined',
  'InvalidContext',
] as const;
export type Condition = Signal | (typeof INVALID_CONDITIONS)[number];

/** The conditions that a signal stands for. */
export function conditionsOf(signal: Signal): readonly Condition[] {
  return signal === 'InvalidOperation' ? INVALID_CONDITIONS : [signal];
}

export function conditionSet(signals: readonly Signal[]): Set<Condition> {
  return new Set(signals.flatMap(conditionsOf));
}

export function signalOf(condition: Condition): Signal {
  return (INVALID_CONDITIONS as readonly string[]).includes(condition) ? 'InvalidOperation' : (condition as Signal);
}

/** The state of a `decimal.Context`, plus the conditions the operation in progress has met. */
export interface DecimalContext {
  prec: number;
  rounding: Rounding;
  Emin: number;
  Emax: number;
  capitals: number;
  clamp: number;
  /** The conditions met, which libmpdec keeps as separate status bits even for the signal InvalidOperation. */
  flags: Set<Condition>;
  traps: Set<Condition>;
  status: Set<Condition>;
}

export function newContextState(overrides: Partial<DecimalContext> = {}): DecimalContext {
  return {
    prec: 28,
    rounding: 'ROUND_HALF_EVEN',
    Emin: -999_999,
    Emax: 999_999,
    capitals: 1,
    clamp: 0,
    flags: new Set(),
    traps: conditionSet(['InvalidOperation', 'DivisionByZero', 'Overflow']),
    status: new Set(),
    ...overrides,
  };
}

export function copyContextState(context: DecimalContext): DecimalContext {
  return { ...context, flags: new Set(context.flags), traps: new Set(context.traps), status: new Set() };
}

export function etiny(context: DecimalContext): number {
  return context.Emin - context.prec + 1;
}

export function etop(context: DecimalContext): number {
  return context.Emax - context.prec + 1;
}
