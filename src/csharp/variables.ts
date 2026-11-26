import type { BoundExpression } from './bound';
import { isValueType } from './types';

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
    case 'deref':
    case 'refValue':
    case 'compoundOperand': {
      return true;
    }
    case 'staticField': {
      return !(readonlyIsValue && expression.field.isReadonly);
    }
    case 'implicitIndex': {
      return isVariable(expression.access, readonlyIsValue);
    }
    case 'call': {
      return expression.method.returnsByRef === 'ref';
    }
    case 'invokeDelegate': {
      return expression.returnsByRef === 'ref';
    }
    case 'property': {
      return expression.property.returnsByRef === 'ref';
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

/**
 * Whether a variable is fixed, so that `&` takes its address without a `fixed` statement: a local or value parameter,
 * a field of a struct that is fixed, or what a pointer points to (C# spec §24.4).
 */
export function isFixedVariable(expression: BoundExpression): boolean {
  switch (expression.kind) {
    case 'local': {
      // A ref parameter or ref local may refer to a movable variable.
      return expression.local.refKind === undefined;
    }
    case 'deref': {
      return true;
    }
    case 'field': {
      return isValueType(expression.receiver.type) && isFixedVariable(expression.receiver);
    }
    default: {
      return false;
    }
  }
}
