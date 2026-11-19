import { CppRuntimeError } from '../errors';
import type { Expr } from '../expr';
import type { ExpressionCompiler } from '../expressionCompiler';
import type { Eval } from '../runtime';
import { BOOL, ClassInfo, classType, isInteger, LONG, PTRDIFF_T, type Type, typeName, withConst } from '../types';
import { NULL_PTR, Ptr, type Store } from '../values';
import type { BitReferences } from './bitReference';
import type { IteratorCategory } from './libraryClass';
import { nativeConstructor } from './support';

/** The operators that only a random-access iterator has. */
const RANDOM_ACCESS_OPERATORS = new Set(['+', '-', '+=', '-=', '[]', '<', '<=', '>', '>=']);
/** The operators that a forward iterator lacks. */
const BIDIRECTIONAL_OPERATORS = new Set(['--', 'x--']);
const MUTATING_OPERATORS = new Set(['++', '--', 'x++', 'x--', '+=', '-=']);

/**
 * The iterator of a container, whose value is a `Ptr` to an element of the container's store, and whose operators are
 * those of its category. A reverse iterator points one past the element it designates, as `std::reverse_iterator`
 * does.
 */
export function randomAccessIterator(
  cache: Map<string, ClassInfo>,
  container: string,
  element: Type,
  isConst: boolean,
  isReverse: boolean,
  category: IteratorCategory = 'randomAccess',
  bits?: BitReferences
): ClassInfo {
  const name = `${container}::${isReverse ? (isConst ? 'const_reverse_iterator' : 'reverse_iterator') : isConst ? 'const_iterator' : 'iterator'}`;
  const cached = cache.get(name);
  if (cached) return cached;
  const cls = new ClassInfo(name, 'class');
  cls.isComplete = true;
  cache.set(name, cls);
  const elementType = isConst ? withConst(element) : element;
  cls.library = {
    kind: 'iterator',
    args: [elementType],
    isReverse,
    iteratorCategory: category,
    iteratorReference: isConst ? bits?.constant : bits?.mutable,
    size: 8,
    align: 8,
    operator: (compiler, operator, operands, row) =>
      hasOperator(category, operator)
        ? iteratorOperator(
            compiler,
            cls,
            elementType,
            isReverse,
            operator,
            withTemporaryTarget(compiler, operator, operands),
            row
          )
        : undefined,
  };
  cls.operations = {
    copyIsNoexcept: true,
    copy: (_frame, value) => value,
    assign: (_frame, _target, source) => source,
  };
  cls.constructors = [nativeConstructor(cls, [], () => NULL_PTR)];
  if (isConst) {
    const mutable = randomAccessIterator(cache, container, element, false, isReverse, category, bits);
    cls.constructors.push(nativeConstructor(cls, [classType(mutable)], ([value]) => value));
  }
  return cls;
}

function hasOperator(category: IteratorCategory, operator: string): boolean {
  if (category === 'randomAccess') return true;
  return (
    !RANDOM_ACCESS_OPERATORS.has(operator) && (category === 'bidirectional' || !BIDIRECTIONAL_OPERATORS.has(operator))
  );
}

/**
 * The operands with a prvalue that `++`, `--`, `+=`, or `-=` modifies made a temporary, as an iterator is a class
 * object whose member operators take one (`++v.begin()`).
 */
function withTemporaryTarget(compiler: ExpressionCompiler, operator: string, operands: Expr[]): Expr[] {
  const [target, ...rest] = operands;
  if (!target || target.isLvalue || !MUTATING_OPERATORS.has(operator)) return operands;
  return [compiler.materialize(target), ...rest];
}

/** The element a sequence iterator designates, checking that it is one. */
export function elementLocation(pointer: Ptr, isReverse: boolean): Ptr {
  return pointer.element(isReverse);
}

export function positionOf(container: Store, position: unknown, allowEnd = true): number {
  if (!(position instanceof Ptr) || position.store !== container) throw new CppRuntimeError('invalidIterator');
  container.checkAlive();
  const index = position.index;
  const last = allowEnd ? container.length : container.length - 1;
  if (index < 0 || index > last) throw new CppRuntimeError('invalidIterator');
  return index;
}

export function rangePositions(container: Store, first: unknown, last: unknown): [number, number] {
  const from = positionOf(container, first);
  const to = positionOf(container, last);
  if (from > to) throw new CppRuntimeError('invalidRange');
  return [from, to];
}

/** Moves an iterator by `delta` elements, within the sequence and one past its end. */
export function moveIterator(pointer: Ptr, delta: number, isReverse: boolean): Ptr {
  try {
    return pointer.offset(isReverse ? -delta : delta, true);
  } catch (error) {
    if (error instanceof CppRuntimeError && error.kind === 'pointerOutOfRange')
      throw new CppRuntimeError('invalidIterator');
    throw error;
  }
}

// code-gauge-allow functionCognitiveComplexity 30 -- One case per iterator operator.
function iteratorOperator(
  compiler: ExpressionCompiler,
  cls: ClassInfo,
  element: Type,
  isReverse: boolean,
  operator: string,
  operands: Expr[],
  row: number
): Expr | undefined {
  const [first, second] = operands;
  const isSelf = (expr: Expr | undefined): boolean =>
    expr?.type.kind === 'class' && sameIteratorFamily(expr.type.cls, cls);
  if (!isSelf(first) && !(operator === '+' && isSelf(second))) return undefined;
  const value = (expr: Expr): Eval<Ptr> => compiler.rvalue(expr).run as Eval<Ptr>;
  const type = classType(cls);
  const proxy = cls.library?.iteratorReference;
  switch (operator) {
    case '*':
    case '->': {
      if (operands.length !== 1) return undefined;
      if (proxy && operator === '->') return compiler.error(row, `${cls.name} には -> を使えません。`);
      const run = value(first);
      return { type: proxy ?? element, isLvalue: !proxy, row, run: (frame) => elementLocation(run(frame), isReverse) };
    }
    case '++':
    case '--': {
      compiler.checkAssignable(first, row, operator);
      const location = first.run;
      const delta = operator === '++' ? 1 : -1;
      return {
        type: first.type,
        isLvalue: true,
        row,
        run: (frame) => {
          const place = location(frame) as Ptr;
          place.write(moveIterator(place.read() as Ptr, delta, isReverse));
          return place;
        },
      };
    }
    case 'x++':
    case 'x--': {
      compiler.checkAssignable(first, row, operator.slice(1));
      const location = first.run;
      const delta = operator === 'x++' ? 1 : -1;
      return {
        type,
        isLvalue: false,
        row,
        run: (frame) => {
          const place = location(frame) as Ptr;
          const old = place.read() as Ptr;
          place.write(moveIterator(old, delta, isReverse));
          return old;
        },
      };
    }
    case '+':
    case '-': {
      if (operator === '-' && isSelf(second)) {
        const a = value(first);
        const b = value(second);
        return {
          type: PTRDIFF_T,
          isLvalue: false,
          row,
          run: (frame) => {
            const p = a(frame);
            const q = b(frame);
            if (p.store !== q.store) throw new CppRuntimeError('invalidIterator');
            return BigInt(isReverse ? q.index - p.index : p.index - q.index);
          },
        };
      }
      const [iterator, offset] = isSelf(first) ? [first, second] : [second, first];
      if (!offset || !isInteger(compiler.rvalue(offset).type)) return undefined;
      const it = value(iterator);
      const n = compiler.convert(offset, LONG, row).run;
      const sign = operator === '-' ? -1 : 1;
      return {
        type,
        isLvalue: false,
        row,
        run: (frame) => moveIterator(it(frame), sign * Number(n(frame)), isReverse),
      };
    }
    case '+=':
    case '-=': {
      compiler.checkAssignable(first, row, operator);
      const location = first.run;
      const n = compiler.convert(second, LONG, row).run;
      const sign = operator === '-=' ? -1 : 1;
      return {
        type: first.type,
        isLvalue: true,
        row,
        run: (frame) => {
          const place = location(frame) as Ptr;
          place.write(moveIterator(place.read() as Ptr, sign * Number(n(frame)), isReverse));
          return place;
        },
      };
    }
    case '[]': {
      const it = value(first);
      const n = compiler.convert(second, LONG, row).run;
      return {
        type: proxy ?? element,
        isLvalue: !proxy,
        row,
        run: (frame) => elementLocation(moveIterator(it(frame), Number(n(frame)), isReverse), isReverse),
      };
    }
    case '==':
    case '!=':
    case '<':
    case '<=':
    case '>':
    case '>=': {
      if (!isSelf(second)) {
        return compiler.error(
          row,
          `演算子 ${operator} は ${typeName(first.type)} と ${typeName(second.type)} には使えません。`
        );
      }
      const a = value(first);
      const b = value(second);
      return {
        type: BOOL,
        isLvalue: false,
        row,
        run: (frame) => compareIterators(operator, a(frame), b(frame), isReverse),
      };
    }
    default: {
      return undefined;
    }
  }
}

/** Whether two iterator classes are the same but for `const`, which compare with each other. */
function sameIteratorFamily(a: ClassInfo, b: ClassInfo): boolean {
  return a === b || a.name.replace('const_', '') === b.name.replace('const_', '');
}

function compareIterators(operator: string, a: Ptr, b: Ptr, isReverse: boolean): number {
  if (operator === '==') return a.store === b.store && a.equals(b) ? 1 : 0;
  if (operator === '!=') return a.store === b.store && a.equals(b) ? 0 : 1;
  if (a.store !== b.store) throw new CppRuntimeError('invalidIterator');
  const difference = isReverse ? b.index - a.index : a.index - b.index;
  switch (operator) {
    case '<': {
      return difference < 0 ? 1 : 0;
    }
    case '<=': {
      return difference <= 0 ? 1 : 0;
    }
    case '>': {
      return difference > 0 ? 1 : 0;
    }
    default: {
      return difference >= 0 ? 1 : 0;
    }
  }
}
