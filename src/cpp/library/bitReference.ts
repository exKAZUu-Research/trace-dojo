import { scalarValue } from '../conversions';
import type { Expr } from '../expr';
import type { ExpressionCompiler } from '../expressionCompiler';
import { BOOL, ClassInfo, classType, type Type, VOID } from '../types';
import { type Ptr, type Value } from '../values';
import { addMethod, native } from './support';

export interface BitReferences {
  mutable: Type;
  constant: Type;
}

const OPERATORS = new Set([
  '+',
  '-',
  '*',
  '/',
  '%',
  '~',
  '!',
  '<<',
  '>>',
  '&',
  '|',
  '^',
  '<',
  '<=',
  '>',
  '>=',
  '==',
  '!=',
  '&&',
  '||',
]);

export function bitReferences(): BitReferences {
  return { mutable: makeReference(false), constant: makeReference(true) };
}

function makeReference(isConst: boolean): Type {
  const name = isConst ? 'const_reference' : 'reference';
  const cls = new ClassInfo(`std::vector<bool>::${name}`, 'class');
  cls.isComplete = true;
  cls.isDefaultConstructorDeleted = true;
  cls.isAssignmentDeleted = isConst;
  cls.library = {
    kind: 'bitReference',
    args: [],
    size: 16,
    align: 8,
    scalarValue: { type: BOOL, read: readBit },
    operator: (compiler, operator, [left, right], row) => {
      if (operator === '=' && !isConst && left.type.kind === 'class' && left.type.cls === cls)
        return assignBit(compiler, left, right, row);
      if (operator === 'bool') return scalarValue(compiler, left);
      if (!OPERATORS.has(operator)) return;
      const a = scalarValue(compiler, left);
      return right ? compiler.binary(operator, a, scalarValue(compiler, right), row) : compiler.unary(operator, a, row);
    },
  };
  cls.operations = {
    copyIsNoexcept: true,
    copy: (_frame, value) => value,
    assign: (_frame, target, source) => {
      (target as Ptr).write(readBit(source));
    },
  };
  if (!isConst) {
    addMethod(
      cls,
      native('flip', [], VOID, (_args, { self }) => {
        const bit = self as Ptr;
        bit.write(readBit(bit) === 0 ? 1 : 0);
      })
    );
  }
  return classType(cls);
}

function assignBit(compiler: ExpressionCompiler, target: Expr, value: Expr, row: number): Expr {
  const object = compiler.materialize(target);
  compiler.checkAssignable(object, row, '=');
  const assign = compiler.convert(value, BOOL, row).run;
  return {
    type: target.type,
    isLvalue: true,
    row,
    run: (frame) => {
      const bit = assign(frame) as Value;
      const place = object.run(frame) as Ptr;
      (place.read() as Ptr).write(bit);
      return place;
    },
  };
}

function readBit(value: Value): number {
  return Number((value as Ptr).read());
}
