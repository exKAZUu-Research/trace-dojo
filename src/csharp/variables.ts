import type { BoundExpression } from './bound';

/**
 * Whether an expression denotes a variable, whose struct a member assignment or a method call changes in place: a
 * local, `this`, an array element, a static field, or a field of a class's instance or of a struct that is itself a
 * variable. With `readonlyIsValue`, a readonly field is a value, which a method call changes a copy of.
 */
export function isVariable(expression: BoundExpression, readonlyIsValue: boolean): boolean {
  switch (expression.kind) {
    case 'local':
    case 'this':
    case 'element':
    case 'compoundOperand': {
      return true;
    }
    case 'staticField': {
      return !(readonlyIsValue && expression.field.isReadonly);
    }
    case 'field': {
      if (readonlyIsValue && expression.field.isReadonly) return false;
      const receiver = expression.receiver.type;
      return (
        !(receiver.kind === 'named' && receiver.symbol.isValueType) || isVariable(expression.receiver, readonlyIsValue)
      );
    }
    default: {
      return false;
    }
  }
}
