import type { Expr } from '../expr';
import type { ExpressionCompiler } from '../expressionCompiler';
import { BOOL, ClassInfo, classType, type Type, typeName } from '../types';
import { CObject, type Ptr, type Value } from '../values';

/** The value an ordering holds for "unordered", as libc++ stores it. */
export const UNORDERED = -127;

/** The results of `<=>` of `<compare>`, by name without `std::`, strongest first. */
export const ORDERINGS = ['strong_ordering', 'weak_ordering', 'partial_ordering'] as const;
export type OrderingName = (typeof ORDERINGS)[number];

const CONSTANTS: Record<OrderingName, Record<string, number>> = {
  strong_ordering: { less: -1, equal: 0, equivalent: 0, greater: 1 },
  weak_ordering: { less: -1, equivalent: 0, greater: 1 },
  partial_ordering: { less: -1, equivalent: 0, greater: 1, unordered: UNORDERED },
};

/** `std::strong_ordering`, `std::weak_ordering`, and `std::partial_ordering`, whose objects hold one byte. */
export function orderingClasses(): Map<OrderingName, ClassInfo> {
  const classes = new Map<OrderingName, ClassInfo>();
  for (const name of ORDERINGS) {
    const cls = new ClassInfo(`std::${name}`, 'class');
    cls.isComplete = true;
    classes.set(name, cls);
    cls.library = {
      kind: name,
      args: [],
      size: 1,
      align: 1,
      allowsConstantCopy: true,
      operator: (compiler, operator, operands, row) => orderingOperator(compiler, cls, operator, operands, row),
    };
    cls.operations = {
      copyIsNoexcept: true,
      copy: (_frame, source) => new CObject(cls, [...(source as CObject).values]),
      assign: (_frame, target, source) => {
        (target as CObject).values[0] = (source as CObject).values[0];
      },
    };
    for (const [constant, value] of Object.entries(CONSTANTS[name])) {
      cls.constants.set(constant, (row) => orderingValue(cls, value, row));
    }
  }
  // A stronger ordering converts to a weaker one, keeping its value.
  return classes;
}

/** A prvalue ordering of a class with a known value. */
export function orderingValue(cls: ClassInfo, value: number, row: number): Expr {
  return { type: classType(cls), isLvalue: false, row, run: () => new CObject(cls, [value]), isTemporaryObject: true };
}

/** An ordering whose value `run` gives at run time. */
export function orderingOf(cls: ClassInfo, run: Expr['run'], row: number): Expr {
  return {
    type: classType(cls),
    isLvalue: false,
    row,
    run: (frame) => new CObject(cls, [run(frame) as number]),
    isTemporaryObject: true,
  };
}

/** The value an ordering object holds. */
export function orderingNumber(value: Value): number {
  return (value as CObject).values[0] as number;
}

/**
 * The comparisons of an ordering: with the literal `0`, whose result says how its operands compared, and with an
 * ordering of the same type (C++20 [cmp.categories]).
 */
function orderingOperator(
  compiler: ExpressionCompiler,
  cls: ClassInfo,
  operator: string,
  operands: Expr[],
  row: number
): Expr | undefined {
  if (!['==', '!=', '<', '>', '<=', '>=', '<=>'].includes(operator) || operands.length !== 2) return undefined;
  const [left, right] = operands;
  const isOrdering = (expr: Expr): boolean => expr.type.kind === 'class' && expr.type.cls === cls;
  if (isOrdering(left) && isOrdering(right)) {
    if (operator !== '==' && operator !== '!=')
      return compiler.error(row, `${typeName(left.type)} どうしは ${operator} で比べられません。`);
    const a = compiler.rvalue(left).run;
    const b = compiler.rvalue(right).run;
    return {
      type: BOOL,
      isLvalue: false,
      row,
      run: (frame) =>
        Number((orderingNumber(a(frame) as Value) === orderingNumber(b(frame) as Value)) === (operator === '==')),
    };
  }
  const ordering = isOrdering(left) ? left : isOrdering(right) ? right : undefined;
  const zero = ordering === left ? right : left;
  if (!ordering || !zero.isNullConstant)
    return compiler.error(
      row,
      `${typeName(cls.name ? classType(cls) : (left.type as Type))} は、0 か同じ型の値としか比べられません。`
    );
  const flipped = ordering === right;
  const value = compiler.rvalue(ordering).run;
  return {
    type: BOOL,
    isLvalue: false,
    row,
    run: (frame) => {
      const order = orderingNumber(value(frame) as Value);
      return Number(compareWithZero(flipped ? mirror(operator) : operator, order));
    },
  };
}

function mirror(operator: string): string {
  return { '<': '>', '>': '<', '<=': '>=', '>=': '<=' }[operator] ?? operator;
}

/** Whether an ordering compares with zero as an operator says, an unordered one comparing false but for `!=`. */
export function compareWithZero(operator: string, order: number): boolean {
  if (order === UNORDERED) return operator === '!=';
  switch (operator) {
    case '==': {
      return order === 0;
    }
    case '!=': {
      return order !== 0;
    }
    case '<': {
      return order < 0;
    }
    case '>': {
      return order > 0;
    }
    case '<=': {
      return order <= 0;
    }
    default: {
      return order >= 0;
    }
  }
}

export type { Ptr };
