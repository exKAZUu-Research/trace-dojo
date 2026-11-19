import { binaryOperation, convertScalar, type Scalar } from '../../c/arith';
import { commonType, promote } from '../../c/types';
import { CompileError } from '../../interpreter/diagnostics';
import { CppRuntimeError, overflowError } from '../errors';
import type { Expr } from '../expr';
import type { ExpressionCompiler } from '../expressionCompiler';
import { invoke, makeEach, withTemporaries } from '../objectCompiler';
import { type Frame, holdAll } from '../runtime';
import {
  BOOL,
  ClassInfo,
  classType,
  type FunctionInfo,
  intMax,
  isArithmetic,
  isConstType,
  isInteger,
  isWide,
  LONG,
  nonReference,
  PTRDIFF_T,
  referenceTo,
  sameType,
  SIZE_T,
  type Type,
  typeName,
  unqualified,
  VOID,
  withConst,
} from '../types';
import { Box, CObject, endLifetime, NULL_PTR, Ptr, type Store, type Value } from '../values';
import { pairClass } from './associative';
import {
  assignElement,
  type CallbackOperand,
  callbackOperands,
  comparatorOf,
  constructElementFromRvalue,
  type ElementOperations,
  elementOperations,
  equalTo,
  functionCallback,
  lessThan,
  locationOf,
  moveAssignElement,
  moveValue,
  predicateCallback,
  requireMoves,
  swapElements,
  truthy,
} from './elements';
import { elementLocation } from './iterators';
import type { IteratorCategory } from './libraryClass';
import type { EngineValue } from './random';
import { uniformInteger } from './random';
import type { Library } from './registry';
import type { StringValue } from './string';
import { constRef, generic, native, readCString } from './support';

/** What an argument's type tells of an iterator: the element it designates, its category, and whether it goes backward. */
interface IteratorInfo {
  element: Type;
  reference?: Type;
  category: IteratorCategory;
  isReverse: boolean;
  isOutput?: boolean;
  appendMethod?: FunctionInfo;
}

function iteratorInfo(type: Type): IteratorInfo | undefined {
  if (type.kind === 'pointer' && type.to.kind !== 'void')
    return { element: type.to, category: 'randomAccess', isReverse: false };
  if (type.kind === 'class' && type.cls.library?.kind === 'iterator') {
    return {
      element: type.cls.library.args[0],
      reference: type.cls.library.iteratorReference,
      category: type.cls.library.iteratorCategory ?? 'randomAccess',
      isReverse: type.cls.library.isReverse === true,
    };
  }
  if (type.kind === 'class' && type.cls.library?.kind === 'back_insert_iterator') {
    return {
      element: type.cls.library.args[0],
      category: 'forward',
      isReverse: false,
      isOutput: true,
      appendMethod: type.cls.library.appendMethod,
    };
  }
  return undefined;
}

function iteratorOperand(info: IteratorInfo): CallbackOperand {
  return info.reference ? { type: info.reference, category: 'prvalue' } : { type: info.element };
}

/** The elements between two iterators, addressed by their positions from the first. */
class Range {
  readonly length: number;

  constructor(
    readonly first: Ptr,
    last: Ptr,
    private readonly info: IteratorInfo,
    private readonly write?: { frame: Frame; ops: ElementOperations; move: boolean }
  ) {
    this.length = first.rangeLength(last, info.isReverse);
  }

  private index(position: number): number {
    if (position < 0 || position >= this.length) throw new CppRuntimeError('invalidComparator');
    return this.info.isReverse ? this.first.index - 1 - position : this.first.index + position;
  }

  get(position: number): Value {
    const index = this.index(position);
    return this.first.target().get(index);
  }

  location(position: number): Ptr {
    const index = this.index(position);
    return this.first.target().location(index);
  }

  comparisonValue(position: number): Value {
    return this.info.reference ? this.location(position) : this.get(position);
  }

  set(position: number, value: Value): void {
    if (!this.write) {
      const index = this.index(position);
      this.first.target().set(index, value);
      return;
    }
    const { frame, ops, move } = this.write;
    const location = this.location(position);
    if (move) moveAssignElement(frame, location, ops.type, value);
    else assignElement(frame, location, ops, value);
  }

  take(position: number): Value {
    const value = this.get(position);
    if (!this.write) return value;
    const { frame, ops, move } = this.write;
    const object = move ? constructElementFromRvalue(frame, ops.type, value) : ops.copy(frame, value);
    if (ops.destroy) frame.temporaries.push({ object, destroy: ops.destroy });
    return object;
  }

  withTemporary<T>(position: number, use: (value: Value) => T): T {
    const frame = this.write?.frame;
    if (!frame) return use(this.get(position));
    return withTemporaries(frame, () => use(this.take(position)));
  }

  swap(a: number, b: number): void {
    if (a === b) return;
    if (this.write) {
      swapElements(this.write.frame, this.location(a), this.location(b), this.write.ops);
    } else {
      const value = this.get(a);
      this.set(a, this.get(b));
      this.set(b, value);
    }
  }

  /** The iterator at a position, which may be one past the last element. */
  iterator(position: number): Ptr {
    if (position === 0) return this.first;
    return this.first.offset(this.info.isReverse ? -position : position, true);
  }
}

/** Where an output iterator writes: into a range, or at the end of a container through `std::back_inserter`. */
class Output {
  private position = 0;

  constructor(
    private readonly start: Ptr,
    private readonly info: IteratorInfo,
    private readonly frame: Frame,
    private readonly operations: ElementOperations,
    private readonly prepare: ReturnType<typeof assignmentSource>
  ) {}

  write(value: Value): void {
    this.prepare(this.frame, value, (converted) => this.writeConverted(converted));
  }

  private writeConverted(value: Value): void {
    const append = this.info.appendMethod;
    if (append) {
      const argument = append.params[0].type.kind === 'reference' ? locationOf(value) : value;
      invoke(this.frame, append, [argument], this.start, append.row);
      return;
    }
    const offset = this.info.isReverse ? -1 - this.position : this.position;
    assignElement(this.frame, this.start.offset(offset), this.operations, value);
    this.position++;
  }

  get end(): Ptr {
    if (this.info.isOutput || this.position === 0) return this.start;
    return this.start.offset(this.info.isReverse ? -this.position : this.position);
  }
}

type Less = (a: Value, b: Value) => boolean;

const ARRAY_REFERENCE_FUNCTIONS = new Set([
  'begin',
  'end',
  'cbegin',
  'cend',
  'rbegin',
  'rend',
  'size',
  'advance',
  'swap',
]);

type TemplateParameterPositions = readonly (readonly number[])[];

/** The function templates of `<algorithm>`, `<numeric>`, `<iterator>`, and `<utility>`. */
// code-gauge-allow functionNcss 400 -- One definition per algorithm, each a few lines.
export function algorithmFunctions(library: Library): Map<string, FunctionInfo[]> {
  const functions = new Map<string, FunctionInfo[]>();
  const compiler = (): ExpressionCompiler => library.compiler;
  const define = (
    name: string,
    parameters: TemplateParameterPositions | ((args: Expr[], types: Type[]) => TemplateParameterPositions),
    instantiate: (args: Expr[], templateArgs: Type[] | undefined) => FunctionInfo | undefined
  ): void => {
    const overload = generic(name, (args, templateArgs) => {
      if (args.some((arg) => arg.functions && arg.functions.candidates.length !== 1)) return;
      const adjusted = ARRAY_REFERENCE_FUNCTIONS.has(name)
        ? args
        : args.map((arg) => (arg.type.kind === 'array' ? compiler().rvalue(arg) : arg));
      if (!templateArgs?.length) return instantiate(adjusted, templateArgs);
      const positions = typeof parameters === 'function' ? parameters(adjusted, templateArgs) : parameters;
      const typed = explicitAlgorithmArguments(adjusted, positions, templateArgs);
      if (typed) return instantiate(typed, templateArgs);
    });
    functions.set(name, [...(functions.get(name) ?? []), overload]);
  };
  /** The comparison an algorithm uses: the argument at `index`, or `<`. */
  const lessOf = (
    args: Expr[],
    index: number,
    info: IteratorInfo,
    usesStoredValues = false
  ): ((frame: Frame) => Less) | undefined => {
    const { element, reference } = info;
    const compare = args[index];
    if (!reference) return orderOf(compare, [element, element], args[0].row);
    if (compare) return bitIteratorOrder(compiler(), compare, info, usesStoredValues);
    const order = orderOf(undefined, [element, element], args[0].row);
    if (order) {
      return (frame) => {
        const less = order(frame);
        return (a, b) => less(a instanceof Ptr ? a.read() : a, b instanceof Ptr ? b.read() : b);
      };
    }
  };
  /** The comparison `arg` makes between values of the two types, or `<` without it. */
  const orderOf = (arg: Expr | undefined, types: [Type, Type], row: number): ((frame: Frame) => Less) | undefined => {
    if (!arg) {
      const [left, right] = types;
      const less = sameType(left, right, false) ? lessThan(left) : undefined;
      if (less) return () => (a, b) => less(a, b) < 0;
      const compare = valueComparison(compiler(), '<', left, right, row);
      return compare ? (frame) => (a, b) => compare(frame, a, b) : undefined;
    }
    const call = comparatorOf(compiler(), unqualified(arg.type), arg.functions, types, arg.row);
    if (!call) return undefined;
    return (frame) => (a, b) => truthy(call(frame, a, b));
  };
  /** A predicate of the expressions an algorithm passes, including proxy dereferences. */
  const predicateOf = (
    arg: Expr | undefined,
    ...operands: CallbackOperand[]
  ): ((frame: Frame, ...locations: Ptr[]) => Value) | undefined => {
    if (!arg) return undefined;
    return predicateCallback(compiler(), unqualified(arg.type), arg.functions, operands, arg.row);
  };

  /** Stops when an algorithm gets iterators of a weaker category than it needs, as libc++ rejects them. */
  const checkCategory = (name: string, info: IteratorInfo, needed: IteratorCategory, row: number): void => {
    if (needed === 'randomAccess' && info.category !== 'randomAccess')
      compiler().error(
        row,
        `std::${name} には、ランダムアクセスイテレータ（vector や配列などのもの）を渡してください。`
      );
    if (info.category === 'forward')
      compiler().error(row, `std::${name} には、双方向イテレータ（-- で戻れるもの）を渡してください。`);
  };

  // Sorting -------------------------------------------------------------------------------------------------------
  for (const name of ['sort', 'stable_sort']) {
    define(name, [[0, 1], [2]], (args) => {
      const info = writableRangeAt(args, 0);
      if (!info || args.length > 3) return;
      checkCategory(name, info, 'randomAccess', args[0].row);
      const less = lessOf(args, 2, info, true);
      if (!less)
        return compiler().error(
          args[0].row,
          `${typeName(info.element)} の値は < で比べられません。比べ方を表す関数を渡してください。`
        );
      const type = unqualified(info.element);
      requireMoves(compiler(), type, args[0].row);
      const ops = elementOperations(compiler(), type, args[0].row);
      return native(name, params(args), VOID, ([first, last], { frame }) => {
        const values = mutableRange(first, last, info, frame, ops, true);
        frame.runtime.spend(values.length);
        if (name === 'sort') introsort(values, less(frame));
        else stableSort(values, less(frame));
        return;
      });
    });
  }
  define('reverse', [[0, 1]], (args) => {
    const info = writableRangeAt(args, 0);
    if (!info || args.length !== 2) return;
    checkCategory('reverse', info, 'bidirectional', args[0].row);
    const ops = elementOperations(compiler(), unqualified(info.element), args[0].row, 'swap');
    return native('reverse', params(args), VOID, ([first, last], { frame }) => {
      const values = mutableRange(first, last, info, frame, ops);
      for (let i = 0, j = values.length - 1; i < j; i++, j--) values.swap(i, j);
      return;
    });
  });
  for (const name of ['next_permutation', 'prev_permutation']) {
    define(name, [[0, 1], [2]], (args) => {
      const info = writableRangeAt(args, 0);
      if (!info || args.length > 3) return;
      checkCategory(name, info, 'bidirectional', args[0].row);
      const less = lessOf(args, 2, info);
      if (!less) return;
      const ops = elementOperations(compiler(), unqualified(info.element), args[0].row, 'swap');
      return native(name, params(args), BOOL, ([first, last], { frame }) => {
        const values = mutableRange(first, last, info, frame, ops);
        const compare = less(frame);
        const ordered = name === 'next_permutation' ? compare : (a: Value, b: Value): boolean => compare(b, a);
        return permute(values, ordered) ? 1 : 0;
      });
    });
  }
  define('shuffle', [[0, 1], [2]], (args) => {
    const info = writableRangeAt(args, 0);
    if (!info || args.length !== 3 || args[2].type.kind !== 'class' || args[2].type.cls.library?.kind !== 'engine')
      return;
    if (isConstType(args[2].type)) return;
    checkCategory('shuffle', info, 'randomAccess', args[0].row);
    const engineType = args[2].isLvalue ? referenceTo(args[2].type) : args[2].type;
    const ops = elementOperations(compiler(), unqualified(info.element), args[0].row, 'swap');
    return native('shuffle', [...params(args).slice(0, 2), engineType], VOID, ([first, last, engine], { frame }) => {
      const values = mutableRange(first, last, info, frame, ops);
      const generator = readArg(engine, engineType) as EngineValue;
      // libc++'s shuffle draws with uniform_int_distribution<ptrdiff_t>.
      for (let at = 0, remaining = values.length - 1; at < values.length - 1; at++, remaining--) {
        const offset = Number(uniformInteger(generator, 0n, BigInt(remaining), 64));
        if (offset !== 0) values.swap(at, at + offset);
      }
      return;
    });
  });

  // Searching and counting ------------------------------------------------------------------------------------------
  for (const name of ['min_element', 'max_element']) {
    define(name, [[0, 1], [2]], (args) => {
      const info = rangeAt(args, 0);
      if (!info || args.length > 3) return;
      const less = lessOf(args, 2, info);
      if (!less) return;
      return native(name, params(args), unqualified(args[0].type), ([first, last], { frame }) => {
        const values = range(first, last, info);
        const compare = less(frame);
        let best = 0;
        for (let index = 1; index < values.length; index++) {
          if (
            name === 'min_element'
              ? compare(values.comparisonValue(index), values.comparisonValue(best))
              : compare(values.comparisonValue(best), values.comparisonValue(index))
          )
            best = index;
        }
        return values.iterator(values.length === 0 ? 0 : best);
      });
    });
  }
  define('find', [[0, 1], [2]], (args) => {
    const info = rangeAt(args, 0);
    if (!info || args.length !== 3) return;
    const equal = valueEquality(compiler(), info.element, decayed(args[2].type), args[0].row);
    if (!equal) return;
    const types = params(args);
    return native('find', types, unqualified(args[0].type), ([first, last, value], { frame }) => {
      const values = range(first, last, info);
      const matches = bindEquality(equal, frame, readArg(value, types[2]));
      for (let index = 0; index < values.length; index++) if (matches(values.get(index))) return values.iterator(index);
      return values.iterator(values.length);
    });
  });
  for (const name of ['find_if', 'find_if_not']) {
    define(name, [[0, 1], [2]], (args) => {
      const info = rangeAt(args, 0);
      if (!info || args.length !== 3) return;
      const predicate = predicateOf(args[2], iteratorOperand(info));
      if (!predicate) return;
      return native(name, params(args), unqualified(args[0].type), ([first, last], { frame }) => {
        const values = range(first, last, info);
        for (let index = 0; index < values.length; index++) {
          if (truthy(predicate(frame, values.location(index))) === (name === 'find_if')) return values.iterator(index);
        }
        return values.iterator(values.length);
      });
    });
  }
  define('count', [[0, 1], [2]], (args) => {
    const info = rangeAt(args, 0);
    if (!info || args.length !== 3) return;
    const equal = valueEquality(compiler(), info.element, decayed(args[2].type), args[0].row);
    if (!equal) return;
    const types = params(args);
    return native('count', types, PTRDIFF_T, ([first, last, value], { frame }) => {
      const values = range(first, last, info);
      const matches = bindEquality(equal, frame, readArg(value, types[2]));
      let count = 0;
      for (let index = 0; index < values.length; index++) if (matches(values.get(index))) count++;
      return BigInt(count);
    });
  });
  define('count_if', [[0, 1], [2]], (args) => {
    const info = rangeAt(args, 0);
    if (!info || args.length !== 3) return;
    const predicate = predicateOf(args[2], iteratorOperand(info));
    if (!predicate) return;
    return native('count_if', params(args), PTRDIFF_T, ([first, last], { frame }) => {
      const values = range(first, last, info);
      let count = 0;
      for (let index = 0; index < values.length; index++) if (truthy(predicate(frame, values.location(index)))) count++;
      return BigInt(count);
    });
  });
  for (const name of ['all_of', 'any_of', 'none_of']) {
    define(name, [[0, 1], [2]], (args) => {
      const info = rangeAt(args, 0);
      if (!info || args.length !== 3) return;
      const predicate = predicateOf(args[2], iteratorOperand(info));
      if (!predicate) return;
      return native(name, params(args), BOOL, ([first, last], { frame }) => {
        const values = range(first, last, info);
        for (let index = 0; index < values.length; index++) {
          const test = truthy(predicate(frame, values.location(index)));
          if (name === 'all_of' && !test) return 0;
          if (name === 'any_of' && test) return 1;
          if (name === 'none_of' && test) return 0;
        }
        return name === 'any_of' ? 0 : 1;
      });
    });
  }
  for (const name of ['lower_bound', 'upper_bound', 'binary_search']) {
    define(name, [[0, 1], [2], [3]], (args) => {
      const info = rangeAt(args, 0);
      if (!info || args.length < 3 || args.length > 4) return;
      const types = params(args);
      const valueType = types[2];
      // A comparator may take the element and the value in different types: (element, value) for lower_bound and
      // (value, element) for upper_bound.
      const elementType = unqualified(info.element);
      const searched = unqualified(valueType.kind === 'reference' ? valueType.to : valueType);
      const boundOrder = (elementFirst: boolean): ((frame: Frame) => Less) | undefined => {
        const comparator = args[3];
        if (!info.reference || !comparator) {
          const types: [Type, Type] = elementFirst ? [elementType, searched] : [searched, elementType];
          return orderOf(comparator, types, args[0].row);
        }
        const element = iteratorOperand(info);
        const key = { type: withConst(searched) };
        const operands = elementFirst ? [element, key] : [key, element];
        const predicate = predicateOf(comparator, ...operands);
        if (predicate) {
          return (frame) => (a, b) =>
            truthy(
              predicate(frame, elementFirst ? (a as Ptr) : locationOf(a), elementFirst ? locationOf(b) : (b as Ptr))
            );
        }
      };
      const elementFirst = name !== 'upper_bound' ? boundOrder(true) : undefined;
      const valueFirst = name !== 'lower_bound' ? boundOrder(false) : undefined;
      if ((name !== 'upper_bound' && !elementFirst) || (name !== 'lower_bound' && !valueFirst)) return;
      return native(
        name,
        types,
        name === 'binary_search' ? BOOL : unqualified(args[0].type),
        ([first, last, value], { frame }) => {
          const values = range(first, last, info);
          const elementLess = elementFirst?.(frame) as Less;
          const valueLess = valueFirst?.(frame) as Less;
          const target = readArg(value, valueType);
          const element = (index: number): Value =>
            info.reference && args[3] ? values.comparisonValue(index) : values.get(index);
          const upper = name === 'upper_bound';
          let low = 0;
          let count = values.length;
          while (count > 0) {
            const step = Math.floor(count / 2);
            const middle = low + step;
            const goesRight = upper ? !valueLess(target, element(middle)) : elementLess(element(middle), target);
            if (goesRight) {
              low = middle + 1;
              count -= step + 1;
            } else count = step;
          }
          if (name === 'binary_search') return low < values.length && !valueLess(target, element(low)) ? 1 : 0;
          return values.iterator(low);
        }
      );
    });
  }
  define('equal', equalTemplateParameters, (args, templateArgs) => {
    const info = rangeAt(args, 0);
    if (!info || args.length < 3 || args.length > 5) return;
    const other = iteratorInfo(decayed(args[2].type));
    if (!other) return;
    // equal(first1, last1, first2[, last2][, pred]): a fourth argument is the end of the second range or a predicate.
    const hasEnd = !(args.length === 4 && templateArgs?.length === 3) && equalHasSecondEnd(args);
    const predicateArg = args[hasEnd ? 4 : 3];
    const predicate = predicateArg
      ? predicateOf(predicateArg, iteratorOperand(info), iteratorOperand(other))
      : undefined;
    const equal = valueEquality(compiler(), info.element, other.element, args[0].row);
    if (predicateArg ? !predicate : !equal) return;
    // libc++ compares the lengths first only when both ranges are random access.
    const random = isRandomAccess(decayed(args[0].type)) && isRandomAccess(decayed(args[2].type));
    return native('equal', params(args), BOOL, ([first, last, start, end], { frame }) => {
      const values = range(first, last, info);
      const otherLength = hasEnd ? range(start, end, other).length : values.length;
      if (random && otherLength !== values.length) return 0;
      const length = Math.min(values.length, otherLength);
      const others = rangeWithLength(start, length, other);
      for (let index = 0; index < length; index++) {
        const matches = predicate
          ? truthy(predicate(frame, values.location(index), others.location(index)))
          : (equal as ValueEquality).test(frame, values.get(index), others.get(index));
        if (!matches) return 0;
      }
      return values.length === otherLength ? 1 : 0;
    });
  });

  // Modifying -------------------------------------------------------------------------------------------------------
  define('fill', [[0, 1], [2]], (args) => {
    const info = writableRangeAt(args, 0);
    if (!info || args.length !== 3) return;
    const itemType = constRef(unqualified(args[2].type));
    const source: Ptr[] = [];
    const argument: Expr = {
      type: itemType.kind === 'reference' ? itemType.to : itemType,
      isLvalue: true,
      row: args[2].row,
      run: () => source.at(-1),
    };
    const convert = tryCompile(() => compiler().convert(argument, constRef(unqualified(info.element)), argument.row));
    if (!convert) return;
    const ops = elementOperations(compiler(), unqualified(info.element), args[0].row, 'assign');
    return native('fill', [...params(args).slice(0, 2), itemType], VOID, ([first, last, item], { frame }) => {
      const values = range(first, last, info);
      source.push(item as Ptr);
      try {
        for (let index = 0; index < values.length; index++) {
          withTemporaries(frame, () => {
            assignElement(frame, values.location(index), ops, (convert.run(frame) as Ptr).read());
          });
        }
      } finally {
        source.pop();
      }
    });
  });
  define('iota', [[0, 1], [2]], (args) => {
    const info = writableRangeAt(args, 0);
    if (!info || args.length !== 3) return;
    const element = unqualified(info.element);
    const source = unqualified(args[2].type);
    if (!isArithmetic(element) || !isArithmetic(source) || source.name === 'bool') return;
    const incrementType = source.kind === 'int' ? promote(source) : source;
    const add = binaryOperation('+', incrementType);
    const one = convertScalar(1, { kind: 'int', name: 'int' }, incrementType);
    return native('iota', params(args), VOID, ([first, last, start]) => {
      const values = range(first, last, info);
      let current = start as Scalar;
      for (let index = 0; index < values.length; index++) {
        values.set(index, convertScalar(current, source, element));
        current = convertScalar(add(convertScalar(current, source, incrementType), one), incrementType, source);
      }
      return;
    });
  });
  for (const name of ['replace', 'replace_if']) {
    define(name, [[0, 1], ...(name === 'replace' ? [[2, 3]] : [[2], [3]])], (args) => {
      const info = writableRangeAt(args, 0);
      if (!info || args.length !== 4) return;
      const predicate = name === 'replace_if' ? predicateOf(args[2], iteratorOperand(info)) : undefined;
      const equal =
        name === 'replace' ? valueEquality(compiler(), info.element, decayed(args[2].type), args[0].row) : undefined;
      if (!predicate && !equal) return;
      const ops = elementOperations(compiler(), unqualified(info.element), args[0].row, 'assign');
      const types = params(args);
      const convert = assignmentSource(
        compiler(),
        { type: withConst(nonReference(types[3])) },
        info.element,
        args[3].row
      );
      return native(name, types, VOID, ([first, last, old, replacement], { frame }) => {
        const values = range(first, last, info);
        const target = name === 'replace' ? readArg(old, types[2]) : undefined;
        const value = types[3].kind === 'reference' ? (replacement as Ptr) : locationOf(replacement as Value);
        for (let index = 0; index < values.length; index++) {
          if (
            predicate
              ? truthy(predicate(frame, values.location(index)))
              : (equal as ValueEquality).test(frame, values.get(index), target)
          )
            convert(frame, value, (converted) => assignElement(frame, values.location(index), ops, converted));
        }
        return;
      });
    });
  }
  for (const name of ['remove', 'remove_if', 'unique']) {
    define(name, [[0, 1], [2]], (args) => {
      const info = writableRangeAt(args, 0);
      if (!info) return;
      if (name === 'unique' ? args.length > 3 : args.length !== 3) return;
      let keep: (frame: Frame, values: Range, index: number, out: number) => boolean;
      if (name === 'remove') {
        const equal = valueEquality(compiler(), info.element, decayed(args[2].type), args[0].row);
        if (!equal) return;
        const types = params(args);
        keep = (frame, values, index) =>
          !equal.test(frame, values.get(index), readArg(frame.pending.at(-1) as Ptr, types[2]));
      } else if (name === 'remove_if') {
        const predicate = predicateOf(args[2], iteratorOperand(info));
        if (!predicate) return;
        keep = (frame, values, index) => !truthy(predicate(frame, values.location(index)));
      } else {
        const operand = iteratorOperand(info);
        const predicate = predicateOf(args[2], operand, operand);
        const equal = equalTo(unqualified(info.element));
        if (!predicate && !equal) return;
        keep = (frame, values, index, out) =>
          out === 0 ||
          !(predicate
            ? truthy(predicate(frame, values.location(out - 1), values.location(index)))
            : (equal as (a: Value, b: Value) => boolean)(values.get(out - 1), values.get(index)));
      }
      const element = unqualified(info.element);
      compiler().requireLibraryObjectUse(element, 'move-assign', args[0].row);
      return native(name, params(args), unqualified(args[0].type), ([first, last, value], { frame }) => {
        const values = range(first, last, info);
        frame.pending.push(value as Value);
        try {
          // The kept elements move forward, leaving moved-from elements behind them.
          let out = 0;
          for (let index = 0; index < values.length; index++) {
            if (keep(frame, values, index, out)) {
              if (out !== index) values.set(out, moveValue(frame, element, values.get(out), values.get(index)));
              out++;
            }
          }
          return values.iterator(out);
        } finally {
          frame.pending.pop();
        }
      });
    });
  }
  define('rotate', [[0, 1, 2]], (args) => {
    const info = writableRangeAt(args, 0);
    if (!info || args.length !== 3) return;
    const ops = elementOperations(compiler(), unqualified(info.element), args[0].row, 'relocate');
    return native('rotate', params(args), unqualified(args[0].type), ([first, middle, last], { frame }) => {
      const values = mutableRange(first, last, info, frame, ops);
      const split = range(first, middle, info).length;
      const items = Array.from({ length: values.length }, (_, index) => values.take(index));
      const rotated = [...items.slice(split), ...items.slice(0, split)];
      for (const [index, item] of rotated.entries()) values.set(index, item);
      return values.iterator(values.length - split);
    });
  });
  define('swap', [[0, 1]], (args) => {
    if (args.length !== 2) return;
    const bitSwap = bitReferenceSwap(args);
    if (bitSwap) return bitSwap;
    if (!args[0].isLvalue || !args[1].isLvalue) return;
    const type = unqualified(args[0].type);
    if (
      typeName(type) !== typeName(unqualified(args[1].type)) ||
      isConstType(args[0].type) ||
      isConstType(args[1].type)
    )
      return;
    if (type.kind === 'class' && type.cls.isNoncopyable) return;
    const ops = elementOperations(compiler(), type, args[0].row, 'swap');
    return native('swap', [referenceTo(type), referenceTo(type)], VOID, ([a, b], { frame }) => {
      swapElements(frame, a as Ptr, b as Ptr, ops);
    });
  });
  define('iter_swap', [[0], [1]], (args) => {
    const a = outputOf(args[0]);
    const b = outputOf(args[1]);
    if (!a || !b || a.isOutput || b.isOutput || args.length !== 2 || !sameType(a.element, b.element)) return;
    const ops = elementOperations(compiler(), a.element, args[0].row, 'swap');
    return native('iter_swap', params(args), VOID, ([x, y], { frame }) => {
      swapElements(frame, elementLocation(x as Ptr, a.isReverse), elementLocation(y as Ptr, b.isReverse), ops);
    });
  });

  // Copying and transforming ----------------------------------------------------------------------------------------
  for (const name of ['copy', 'copy_if']) {
    define(name, [[0, 1], [2], ...(name === 'copy_if' ? [[3]] : [])], (args) => {
      const info = rangeAt(args, 0);
      const output = outputOf(args[2]);
      if (!info || !output || args.length !== (name === 'copy' ? 3 : 4)) return;
      const predicate = name === 'copy_if' ? predicateOf(args[3], iteratorOperand(info)) : undefined;
      if (name === 'copy_if' && !predicate) return;
      const ops = elementOperations(
        compiler(),
        unqualified(output.element),
        args[2].row,
        output.isOutput ? 'copy' : 'assign'
      );
      const convert = assignmentSource(compiler(), iteratorOperand(info), output.element, args[2].row);
      return native(name, params(args), unqualified(args[2].type), ([first, last, start], { frame }) => {
        const values = range(first, last, info);
        const out = new Output(start as Ptr, output, frame, ops, convert);
        for (let index = 0; index < values.length; index++) {
          const value = values.location(index);
          if (!predicate || truthy(predicate(frame, value))) out.write(value);
        }
        return out.end;
      });
    });
  }
  define('transform', transformTemplateParameters, (args) => {
    const info = rangeAt(args, 0);
    if (!info || (args.length !== 4 && args.length !== 5)) return;
    const isBinary = args.length === 5;
    const output = outputOf(args[isBinary ? 3 : 2]);
    const second = isBinary ? iteratorInfo(unqualified(args[2].type)) : undefined;
    if (!output || (isBinary && !second)) return;
    const operation = compileOperation(
      compiler(),
      args[isBinary ? 4 : 3],
      second ? [iteratorOperand(info), iteratorOperand(second)] : [iteratorOperand(info)]
    );
    if (!operation) return;
    const destination = unqualified(output.element);
    const ops = elementOperations(compiler(), destination, args[0].row, output.isOutput ? 'copy' : 'assign');
    const prepare = assignmentSource(compiler(), operation, destination, args[0].row);
    return native('transform', params(args), unqualified(args[isBinary ? 3 : 2].type), (values, { frame }) => {
      const [first, last] = values;
      const source = range(first, last, info);
      const others = second ? rangeWithLength(values[2], source.length, second) : undefined;
      const out = new Output(values[isBinary ? 3 : 2] as Ptr, output, frame, ops, prepare);
      for (let index = 0; index < source.length; index++) {
        withTemporaries(frame, () => {
          const result = others
            ? invokeOperation(frame, operation, source.location(index), others.location(index))
            : invokeOperation(frame, operation, source.location(index));
          out.write(result);
        });
      }
      return out.end;
    });
  });
  define('for_each', [[0, 1], [2]], (args) => {
    const info = rangeAt(args, 0);
    const callback = args[2];
    if (!info || args.length !== 3 || !callback.functions) return;
    const action = functionCallback(compiler(), callback.functions, [iteratorOperand(info)], callback.row);
    return native('for_each', params(args), VOID, ([first, last], { frame }) => {
      const values = range(first, last, info);
      for (let index = 0; index < values.length; index++) action(frame, values.location(index));
      return;
    });
  });

  // Numeric ------------------------------------------------------------------------------------------------------------
  define('accumulate', [[0, 1], [2], [3]], (args) => {
    const info = rangeAt(args, 0);
    if (!info || (args.length !== 3 && args.length !== 4)) return;
    const initial = args[2];
    const sumType = unqualified(
      initial.type.kind === 'array' ? { kind: 'pointer', to: initial.type.of } : initial.type
    );
    const operands = accumulatorOperands(sumType, iteratorOperand(info));
    const combine = args[3]
      ? compileOperation(compiler(), args[3], operands)
      : binaryStep(compiler(), '+', operands, initial.row);
    if (!combine) return;
    const accumulator = numericAccumulator(compiler(), sumType, combine, initial.row);
    return native(
      'accumulate',
      [...params(args).slice(0, 2), sumType, ...params(args).slice(3)],
      sumType,
      ([first, last, start], { frame }) => {
        const values = range(first, last, info);
        return foldValues(frame, accumulator, start as Value, values.length, (index) => values.location(index));
      }
    );
  });
  define('inner_product', [[0, 1], [2], [3], [4], [5]], (args) => {
    const info = rangeAt(args, 0);
    const other = args[2] ? iteratorInfo(unqualified(args[2].type)) : undefined;
    if (!info || !other || (args.length !== 4 && args.length !== 6)) return;
    const sumType = unqualified(args[3].type);
    const factors = [iteratorOperand(info), iteratorOperand(other)];
    const product = args[5]
      ? compileOperation(compiler(), args[5], factors)
      : binaryStep(compiler(), '*', factors, args[0].row);
    if (!product) return;
    const operands = accumulatorOperands(sumType, product);
    const add = args[4]
      ? compileOperation(compiler(), args[4], operands)
      : binaryStep(compiler(), '+', operands, args[0].row);
    if (!add) return;
    const accumulator = numericAccumulator(compiler(), sumType, add, args[0].row);
    return native(
      'inner_product',
      [...params(args).slice(0, 3), sumType, ...params(args).slice(4)],
      sumType,
      ([first, last, start, initial], { frame }) => {
        const values = range(first, last, info);
        const others = rangeWithLength(start, values.length, other);
        return foldValues(
          frame,
          accumulator,
          initial as Value,
          values.length,
          (index) => (current) => product.run(current, values.location(index), others.location(index))
        );
      }
    );
  });
  define('partial_sum', [[0, 1], [2], [3]], (args) => {
    const info = rangeAt(args, 0);
    const output = outputOf(args[2]);
    if (!info || !output || (args.length !== 3 && args.length !== 4)) return;
    const sumType = unqualified(info.element);
    const operands = accumulatorOperands(sumType, iteratorOperand(info));
    const add = args[3]
      ? compileOperation(compiler(), args[3], operands)
      : binaryStep(compiler(), '+', operands, args[0].row);
    if (!add) return;
    const accumulator = numericAccumulator(compiler(), sumType, add, args[0].row);
    const ops = elementOperations(
      compiler(),
      unqualified(output.element),
      args[2].row,
      output.isOutput ? 'copy' : 'assign'
    );
    const convert = assignmentSource(compiler(), { type: sumType }, output.element, args[2].row);
    return native('partial_sum', params(args), unqualified(args[2].type), ([first, last, start], { frame }) => {
      const values = range(first, last, info);
      const out = new Output(start as Ptr, output, frame, ops, convert);
      if (values.length === 0) return out.end;
      return withTemporaries(frame, () => {
        const initial = accumulator.ops.copy(frame, values.get(0));
        const sum = holdAccumulator(frame, accumulator, initial);
        out.write(sum);
        for (let index = 1; index < values.length; index++) {
          withTemporaries(frame, () => accumulator.update(frame, sum, values.location(index)));
          out.write(sum);
        }
        return out.end;
      });
    });
  });
  for (const name of ['gcd', 'lcm']) {
    define(name, [[0], [1]], (args) => {
      if (args.length !== 2) return;
      const left = unqualified(args[0].type);
      const right = unqualified(args[1].type);
      if (!isInteger(left) || !isInteger(right) || left.name === 'bool' || right.name === 'bool') return;
      const common = sameType(left, right) ? left : commonType(left, right);
      if (!isInteger(common)) return;
      const limit = intMax(common.name);
      return native(name, [left, right], common, ([a, b]) => {
        let x = BigInt(a as number | bigint);
        let y = BigInt(b as number | bigint);
        if (x < 0n) x = -x;
        if (y < 0n) y = -y;
        if (x > limit || y > limit) throw overflowError(typeName(common));
        const gcd = (p: bigint, q: bigint): bigint => (q === 0n ? p : gcd(q, p % q));
        const result = name === 'gcd' ? gcd(x, y) : x === 0n || y === 0n ? 0n : (x / gcd(x, y)) * y;
        if (result > limit) throw overflowError(typeName(common));
        return isWide(common) ? result : Number(result);
      });
    });
  }

  // min, max, clamp ------------------------------------------------------------------------------------------------
  /** The order of min, max, minmax, or clamp: the comparator argument at `index`, or `<`. */
  const extremumOrder = (args: Expr[], index: number, type: Type): ((frame: Frame) => Less) | undefined =>
    orderOf(args[index], [type, type], args[0].row);
  for (const name of ['min', 'max', 'minmax']) {
    define(name, extremumTemplateParameters, (args, templateArgs) => {
      if (args[0]?.braced && args.length <= 2) {
        const elements = args[0].braced.children.map((node) => compiler().compileExpression(node));
        const type = listElementType(elements, templateArgs);
        const less = type ? extremumOrder(args, 1, type) : undefined;
        if (!type || !less) return;
        const result = name === 'minmax' ? pairClass(library, type, type) : undefined;
        return listExtremum(compiler(), name, elements, type, less, params(args).slice(1), result);
      }
      if (args.length !== 2 && args.length !== 3) return;
      const type = templateArgs?.[0] ?? commonDeduced(args[0], args[1]);
      const less = type ? extremumOrder(args, 2, type) : undefined;
      if (!type || !less) return;
      const types = [constRef(type), constRef(type), ...params(args).slice(2)];
      if (name === 'minmax') {
        const result = pairClass(library, referenceTo(withConst(type)), referenceTo(withConst(type)));
        return native('minmax', types, classType(result), ([a, b], { frame }) =>
          less(frame)((b as Ptr).read(), (a as Ptr).read())
            ? new CObject(result, [b as Ptr, a as Ptr])
            : new CObject(result, [a as Ptr, b as Ptr])
        );
      }
      const fn = native(name, types, referenceTo(withConst(type)), ([a, b], { frame }) => {
        const x = (a as Ptr).read();
        const y = (b as Ptr).read();
        // Both return the first of equal values (C++20 [alg.min.max]).
        if (name === 'min') return less(frame)(y, x) ? b : a;
        return less(frame)(x, y) ? b : a;
      });
      if (args.length === 2 && isArithmetic(type)) {
        fn.evaluateConstant = ([a, b]) => ((name === 'min' ? b < a : a < b) ? b : a);
      }
      if (args.length === 2 && supportsConstantOrder(type)) {
        fn.libraryConstant = () => true;
      }
      return fn;
    });
  }
  define('clamp', [[], [3]], (args, templateArgs) => {
    if (args.length !== 3 && args.length !== 4) return;
    const specified = templateArgs?.[0];
    const type = specified ?? commonDeduced(args[0], args[1]);
    if (!type || (!specified && !sameType(type, commonDeduced(args[1], args[2]) ?? VOID))) return;
    const less = extremumOrder(args, 3, type);
    if (!less) return;
    return native(
      'clamp',
      [constRef(type), constRef(type), constRef(type), ...params(args).slice(3)],
      referenceTo(withConst(type)),
      ([v, low, high], { frame }) => {
        const compare = less(frame);
        const lower = (low as Ptr).read();
        const upper = (high as Ptr).read();
        if (compare(upper, lower)) throw new CppRuntimeError('invalidRange');
        const value = (v as Ptr).read();
        if (compare(value, lower)) return low;
        if (compare(upper, value)) return high;
        return v;
      }
    );
  });

  // Iterators ---------------------------------------------------------------------------------------------------------
  for (const name of ['begin', 'end', 'cbegin', 'cend', 'rbegin', 'rend']) {
    define(name, [[0]], (args) => {
      if (args.length !== 1) return;
      const type = args[0].type;
      if (type.kind === 'array' && args[0].isLvalue && !name.startsWith('r')) {
        const length = type.length ?? 0;
        return native(
          name,
          [referenceTo(type)],
          { kind: 'pointer', to: name.startsWith('c') ? withConst(type.of) : type.of },
          ([array]) => new Ptr((array as Ptr).read() as Store, name.endsWith('end') ? length : 0)
        );
      }
      return rangeMemberFunction(compiler(), name, args[0]);
    });
  }
  define('size', [[0]], (args) => {
    if (args.length !== 1) return;
    const type = args[0].type;
    if (type.kind === 'array') return native('size', [referenceTo(type)], SIZE_T, () => BigInt(type.length ?? 0));
    return rangeMemberFunction(compiler(), 'size', args[0]);
  });
  for (const name of ['next', 'prev']) {
    define(name, [[0]], (args) => {
      const info = args[0] ? iteratorInfo(unqualified(args[0].type)) : undefined;
      if (!info || args.length > 2 || (args[1] && !isInteger(unqualified(args[1].type)))) return;
      if (name === 'prev') checkCategory(name, info, 'bidirectional', args[0].row);
      const type = unqualified(args[0].type);
      return native(
        name,
        [type, LONG],
        type,
        ([it, count]) => {
          const steps = count === undefined ? 1 : Number(count);
          const delta = (name === 'next' ? steps : -steps) * (info.isReverse ? -1 : 1);
          return (it as Ptr).offset(delta, true);
        },
        { optional: 1 }
      );
    });
  }
  define('advance', [[0], [1]], (args) => {
    const info = args[0] ? iteratorInfo(unqualified(args[0].type)) : undefined;
    if (!info || args.length !== 2 || !args[0].isLvalue) return;
    const distance = unqualified(args[1].type);
    return native(
      'advance',
      [referenceTo(unqualified(args[0].type)), isInteger(distance) ? distance : LONG],
      VOID,
      ([it, count]) => {
        const location = it as Ptr;
        location.write((location.read() as Ptr).offset(Number(count) * (info.isReverse ? -1 : 1), true));
        return;
      }
    );
  });
  define('distance', [[0, 1]], (args) => {
    const info = rangeAt(args, 0);
    if (!info || args.length !== 2) return;
    return native('distance', params(args), PTRDIFF_T, ([first, last]) => {
      const a = first as Ptr;
      const b = last as Ptr;
      if (a.store !== b.store) throw new CppRuntimeError('invalidRange');
      return BigInt(info.isReverse ? a.index - b.index : b.index - a.index);
    });
  });
  define('back_inserter', [[0]], (args) => {
    const container = args[0];
    if (args.length !== 1 || !container.isLvalue || container.type.kind !== 'class' || isConstType(container.type))
      return;
    const kind = container.type.cls.library?.kind;
    if (kind !== 'vector' && kind !== 'deque' && kind !== 'list' && kind !== 'string') return;
    const append = container.type.cls.methods.get('push_back')?.[0];
    if (!append) return;
    const cls = backInserter(library, container.type, append);
    return native('back_inserter', [referenceTo(container.type)], classType(cls), ([location]) => location);
  });
  return functions;
}

function explicitAlgorithmArguments(
  args: Expr[],
  positions: TemplateParameterPositions,
  types: Type[]
): Expr[] | undefined {
  if (types.length > positions.length) return;
  const typed = [...args];
  for (const [parameter, type] of types.entries()) {
    for (const index of positions[parameter]) {
      const arg = args[index];
      if (!arg) return;
      if (arg.functions) {
        const [fn] = arg.functions.candidates;
        const signature: Type = { kind: 'function', ret: fn.ret, params: fn.params.map((p) => p.type) };
        if (!sameType(signature, type.kind === 'pointer' ? type.to : type)) return;
      }
      typed[index] = { ...arg, type: nonReference(type) };
    }
  }
  return typed;
}

function bitIteratorOrder(
  compiler: ExpressionCompiler,
  arg: Expr,
  info: IteratorInfo,
  usesStoredValues: boolean
): ((frame: Frame) => Less) | undefined {
  const proxy = iteratorOperand(info);
  const bind = (left: CallbackOperand, right: CallbackOperand): ReturnType<typeof predicateCallback> =>
    predicateCallback(compiler, unqualified(arg.type), arg.functions, [left, right], arg.row);
  const twoProxies = bind(proxy, proxy);
  if (!twoProxies) return;
  if (!usesStoredValues) return (frame) => (a, b) => truthy(twoProxies(frame, a as Ptr, b as Ptr));
  const local = { type: info.element };
  const proxyLeft = bind(proxy, local);
  const proxyRight = bind(local, proxy);
  const twoLocals = bind(local, local);
  if (!proxyLeft || !proxyRight || !twoLocals) return;
  return (frame) => (a, b) => {
    if (a instanceof Ptr) {
      return truthy(b instanceof Ptr ? twoProxies(frame, a, b) : proxyLeft(frame, a, locationOf(b)));
    }
    return truthy(
      b instanceof Ptr ? proxyRight(frame, locationOf(a), b) : twoLocals(frame, locationOf(a), locationOf(b))
    );
  };
}

function transformTemplateParameters(args: Expr[]): TemplateParameterPositions {
  return args.length === 5 ? [[0, 1], [2], [3], [4]] : [[0, 1], [2], [3]];
}

function extremumTemplateParameters(args: Expr[]): TemplateParameterPositions {
  return args[0]?.braced && args.length <= 2 ? [[], [1]] : [[], [2]];
}

function equalTemplateParameters(args: Expr[], types: Type[]): TemplateParameterPositions {
  return args.length === 5 || (types.length <= 2 && equalHasSecondEnd(args, types[1]))
    ? [[0, 1], [2, 3], [4]]
    : [[0, 1], [2], [3]];
}

function equalHasSecondEnd(args: Expr[], secondIterator?: Type): boolean {
  if (args.length === 5) return true;
  if (args.length !== 4) return false;
  if (!secondIterator) return rangeAt(args, 2) !== undefined;
  const last = decayed(args[3].type);
  return iteratorInfo(last) !== undefined && sameType(decayed(secondIterator), last);
}

function rangeMemberFunction(compiler: ExpressionCompiler, name: string, arg: Expr): FunctionInfo | undefined {
  if (arg.type.kind !== 'class') return;
  const row = arg.row;
  const useConst = name === 'size' || name.startsWith('c') || isConstType(arg.type) || !arg.isLvalue;
  const type = useConst ? withConst(arg.type) : arg.type;
  const object = { ...arg, type, isLvalue: true };
  const member = name.startsWith('c') ? name.slice(1) : name;
  let fn: FunctionInfo;
  try {
    const functions = compiler.member(object, member, row).functions?.candidates;
    if (!functions) return;
    fn = compiler.resolve(member, functions, [], object, row).fn;
  } catch (error) {
    if (error instanceof CompileError) return;
    throw error;
  }
  if (fn.access !== 'public') return;
  if (!fn.isPure) compiler.checkDefined(fn, row);
  const args = compiler.callArguments(fn, [], row);
  const call = compiler.prepareInvocation(fn, row);
  return native(name, [referenceTo(type)], fn.ret, ([receiver], { frame }) =>
    withTemporaries(frame, () => holdAll(frame, args, (values) => call(frame, values, receiver as Ptr)))
  );
}

/** The iterator pair at `index` of the arguments, with a common element type, or undefined when it is none. */
const rangeAt = (args: Expr[], index: number): IteratorInfo | undefined => {
  const a = args[index];
  const b = args[index + 1];
  if (!a || !b) return undefined;
  const info = iteratorInfo(decayed(a.type));
  if (!info || info.isOutput) return undefined;
  if (!sameType(decayed(a.type), decayed(b.type))) return undefined;
  return info;
};

const writableRangeAt = (args: Expr[], index: number): IteratorInfo | undefined => {
  const info = rangeAt(args, index);
  return info && !isConstType(info.element) ? info : undefined;
};

const params = (args: Expr[]): Type[] =>
  args.map((arg) => {
    if (arg.functions) return { kind: 'function', ret: VOID, params: [] };
    const type = arg.type.kind === 'array' ? { kind: 'pointer' as const, to: arg.type.of } : unqualified(arg.type);
    const kind = type.kind === 'class' ? type.cls.library?.kind : undefined;
    return type.kind === 'class' && kind !== 'iterator' && kind !== 'functor' && kind !== 'back_insert_iterator'
      ? constRef(type)
      : type;
  });

const range = (first: unknown, last: unknown, info: IteratorInfo): Range => new Range(first as Ptr, last as Ptr, info);

function rangeWithLength(begin: unknown, length: number, info: IteratorInfo): Range {
  const first = begin as Ptr;
  return range(first, first.offset(info.isReverse ? -length : length), info);
}

function mutableRange(
  first: unknown,
  last: unknown,
  info: IteratorInfo,
  frame: Frame,
  ops: ElementOperations,
  move = false
): Range {
  const write = info.element.kind === 'class' ? { frame, ops, move } : undefined;
  return new Range(first as Ptr, last as Ptr, info, write);
}

const readArg = (arg: unknown, type: Type): Value => (type.kind === 'reference' ? (arg as Ptr).read() : (arg as Value));

const tryCompile = <T>(make: () => T): T | undefined => {
  try {
    return make();
  } catch (error) {
    if (error instanceof CompileError) return undefined;
    throw error;
  }
};

const outputOf = (arg: Expr | undefined): IteratorInfo | undefined => {
  const info = arg ? iteratorInfo(decayed(arg.type)) : undefined;
  return info && !isConstType(info.element) ? info : undefined;
};

/** `std::back_insert_iterator<Container>`, an output iterator that appends what an algorithm writes. */
function backInserter(library: Library, container: Type, appendMethod: FunctionInfo): ClassInfo {
  const key = `back_insert_iterator<${typeName(container)}#${container.kind === 'class' ? container.cls.id : ''}>`;
  const cached = library.instances.get(key);
  if (cached) return cached;
  const cls = new ClassInfo(`std::back_insert_iterator<${typeName(container)}>`, 'class');
  cls.isComplete = true;
  const element = unqualified(nonReference(appendMethod.params[0].type));
  cls.library = { kind: 'back_insert_iterator', args: [element], size: 8, align: 8, appendMethod };
  cls.operations = {
    copyIsNoexcept: true,
    copy: (_frame, value) => value,
    assign: (_frame, _target, source) => source,
  };
  library.instances.set(key, cls);
  return cls;
}

/** The common type `T` of two arguments of `const T&` parameters, or undefined when deduction fails. */
function commonDeduced(a: Expr, b: Expr): Type | undefined {
  const x = unqualified(a.type);
  const y = unqualified(b.type);
  if (a.braced || b.braced || a.functions || b.functions || x.kind === 'void') return undefined;
  if (typeName(x) !== typeName(y) || (x.kind === 'class' && y.kind === 'class' && x.cls !== y.cls)) return undefined;
  return x;
}

interface ValueEquality {
  test: (frame: Frame, element: Value, other: Value) => boolean;
  bindStable?: (frame: Frame, target: Value) => (element: Value) => boolean;
}

/** How `==` compares an element with an argument, after converting the argument to the element's type. */
function valueEquality(
  compiler: ExpressionCompiler,
  element: Type,
  compared: Type,
  row: number
): ValueEquality | undefined {
  const type = unqualified(element);
  const argType = unqualified(compared);
  if (isArithmetic(type) && isArithmetic(argType)) {
    const promoted = commonType(type, argType);
    return {
      test: (frame, a, b) => {
        frame.runtime.spend();
        return convertScalar(a as Scalar, type, promoted) === convertScalar(b as Scalar, argType, promoted);
      },
    };
  }
  if (type.kind === 'class' && type.cls.library?.kind === 'string') {
    if (argType.kind === 'pointer' && argType.to.kind === 'int' && argType.to.name === 'char') {
      return {
        test: (frame, a, b) =>
          compareStringBytes(frame, stringValueBytes(a), readCString(b as Ptr, undefined, frame.runtime)),
        bindStable: (frame, b) => {
          let target: string | undefined;
          return (a) =>
            compareStringBytes(
              frame,
              stringValueBytes(a),
              (target ??= readCString(b as Ptr, undefined, frame.runtime))
            );
        },
      };
    }
    if (argType.kind === 'class' && argType.cls === type.cls) {
      return { test: (frame, a, b) => compareStringBytes(frame, stringValueBytes(a), stringValueBytes(b)) };
    }
  }
  const equal = sameType(type, argType, false) ? equalTo(type) : undefined;
  if (!equal) {
    const compare = valueComparison(compiler, '==', type, argType, row);
    return compare ? { test: compare } : undefined;
  }
  return {
    test: (frame, a, b) => {
      frame.runtime.spend();
      return equal(a, b);
    },
  };
}

function valueComparison(
  compiler: ExpressionCompiler,
  operator: '<' | '==',
  left: Type,
  right: Type,
  row: number
): ValueEquality['test'] | undefined {
  const input = (type: Type, index: number): Expr => ({
    type,
    isLvalue: false,
    row,
    run: (frame) => frame.pending.at(index),
  });
  let run: Expr['run'];
  try {
    run = compiler.binary(operator, input(left, -2), input(right, -1), row).run;
  } catch (error) {
    if (error instanceof CompileError) return;
    throw error;
  }
  return (frame, a, b) => {
    frame.runtime.spend();
    const mark = frame.pending.length;
    frame.pending.push(a, b);
    try {
      return truthy(run(frame));
    } finally {
      frame.pending.length = mark;
    }
  };
}

function supportsConstantOrder(type: Type): boolean {
  if (isArithmetic(type)) return true;
  const library = type.kind === 'class' ? type.cls.library : undefined;
  return library?.kind === 'string' || (library?.kind === 'pair' && library.args.every(supportsConstantOrder));
}

function bitReferenceSwap(args: Expr[]): FunctionInfo | undefined {
  const types = args.map((arg) => unqualified(arg.type));
  const proxy = types.map(
    (type) => type.kind === 'class' && type.cls.library?.kind === 'bitReference' && !type.cls.isAssignmentDeleted
  );
  if (!proxy.some(Boolean)) return;
  const parameters = types.map((type, index) => {
    if (proxy[index]) return type;
    if (args[index].isLvalue && !isConstType(args[index].type) && sameType(type, BOOL)) return referenceTo(BOOL);
  });
  if (parameters.some((type) => !type)) return;
  return native('swap', parameters as Type[], VOID, ([left, right]) => {
    const a = left as Ptr;
    const b = right as Ptr;
    const first = a.read();
    a.write(b.read());
    b.write(first);
  });
}

function bindEquality(equal: ValueEquality, frame: Frame, target: Value): (element: Value) => boolean {
  return equal.bindStable?.(frame, target) ?? ((element) => equal.test(frame, element, target));
}

function compareStringBytes(frame: Frame, left: string, right: string): boolean {
  frame.runtime.spend(left.length === right.length ? Math.max(1, Math.ceil(left.length / 64)) : 1);
  return left === right;
}

function stringValueBytes(value: Value): string {
  return (value as StringValue).bytes;
}

function assignmentSource(
  compiler: ExpressionCompiler,
  source: CallbackOperand,
  destination: Type,
  row: number
): (frame: Frame, value: Value, use: (value: Value) => void) => void {
  if (sameType(source.type, destination, false)) return (_frame, value, use) => use(readOperandValue(source, value));
  const active: Value[] = [];
  const [value] = callbackOperands([source], row, () => active.at(-1));
  const convert = compiler.convert(value, constRef(destination), row).run;
  return (frame, item, use) => {
    active.push(item);
    try {
      withTemporaries(frame, () => use((convert(frame) as Ptr).read()));
    } finally {
      active.pop();
    }
  };
}

type OperationArgument = Value | ((frame: Frame) => Value);

interface ElementOperation extends CallbackOperand {
  run: (frame: Frame, ...args: OperationArgument[]) => Value;
  destroy?: (frame: Frame, value: Value) => void;
}

interface NumericAccumulator {
  ops: ElementOperations;
  update: (frame: Frame, sum: Ptr, operand: OperationArgument) => void;
}

function numericAccumulator(
  compiler: ExpressionCompiler,
  type: Type,
  operation: ElementOperation,
  row: number
): NumericAccumulator {
  const ops = elementOperations(compiler, type, row, 'relocate');
  const convert = assignmentSource(compiler, operation, type, row);
  const movesResult =
    operation.category !== undefined && !isConstType(operation.type) && sameType(operation.type, type, false);
  return {
    ops,
    update: (frame, sum, operand) => {
      const result = invokeOperation(frame, operation, sum, operand);
      if (movesResult) moveAssignElement(frame, sum, type, readOperandValue(operation, result));
      else convert(frame, result, (converted) => assignElement(frame, sum, ops, converted));
    },
  };
}

function foldValues(
  frame: Frame,
  accumulator: NumericAccumulator,
  initial: Value,
  length: number,
  item: (index: number) => OperationArgument
): Value {
  const sum = holdAccumulator(frame, accumulator, initial);
  for (let index = 0; index < length; index++) {
    withTemporaries(frame, () => accumulator.update(frame, sum, item(index)));
  }
  return constructElementFromRvalue(frame, accumulator.ops.type, sum.read());
}

function holdAccumulator(frame: Frame, accumulator: NumericAccumulator, value: Value): Ptr {
  const { destroy } = accumulator.ops;
  if (destroy) frame.temporaries.push({ object: value, destroy });
  return new Ptr(new Box(value), 0);
}

function accumulatorOperands(type: Type, item: CallbackOperand): CallbackOperand[] {
  return [{ type, category: 'xvalue' }, item];
}

function invokeOperation(frame: Frame, operation: ElementOperation, ...args: OperationArgument[]): Value {
  const result = operation.run(frame, ...args);
  if (operation.destroy) frame.temporaries.push({ object: result, destroy: operation.destroy });
  return result;
}

function readOperandValue(operand: CallbackOperand, value: Value): Value {
  if (operand.category === 'prvalue') return value;
  return operand.type.kind === 'nullptr' ? NULL_PTR : (value as Ptr).read();
}

function compileOperation(
  compiler: ExpressionCompiler,
  operation: Expr,
  operands: CallbackOperand[]
): ElementOperation | undefined {
  const type = operation.type;
  if (!operation.functions && !(type.kind === 'class' && type.cls.library?.kind === 'functor')) return;
  const { row } = operation;
  const functions = operation.functions;
  return makeOperation(compiler, operands, row, (args) =>
    functions
      ? compiler.callCallback(functions, args, row)
      : compiler.callWith({ ...operation, run: () => {} }, args, row)
  );
}

function binaryStep(
  compiler: ExpressionCompiler,
  operator: string,
  operands: CallbackOperand[],
  row: number
): ElementOperation | undefined {
  try {
    return makeOperation(compiler, operands, row, ([left, right]) => compiler.binary(operator, left, right, row));
  } catch (error) {
    if (error instanceof CompileError) return undefined;
    throw error;
  }
}

function makeOperation(
  compiler: ExpressionCompiler,
  operands: CallbackOperand[],
  row: number,
  resolve: (args: Expr[]) => Expr
): ElementOperation {
  const calls: OperationArgument[][] = [];
  const args = callbackOperands(operands, row, (frame, index) => {
    const arg = calls.at(-1)?.[index];
    return typeof arg === 'function' ? arg(frame) : arg;
  });
  const result = resolve(args);
  const { type } = result;
  const category = result.isLvalue ? (result.isXvalue ? 'xvalue' : undefined) : 'prvalue';
  const run: ElementOperation['run'] = (frame, ...values) => {
    calls.push(values);
    try {
      return result.run(frame);
    } finally {
      calls.pop();
    }
  };
  if (!result.isTemporaryObject || type.kind !== 'class') return { type, category, run };
  const destroy = compiler.destroyerOf(type, result.row);
  return {
    type,
    category,
    run,
    destroy: (frame, value) => {
      destroy?.(frame, value);
      endLifetime(value);
    },
  };
}

/** The element type of a braced list argument: the template argument, or the type all the elements have. */
function listElementType(elements: Expr[], templateArgs: Type[] | undefined): Type | undefined {
  if (elements.length === 0) return undefined;
  if (templateArgs?.[0]) return templateArgs[0];
  const type = decayed(elements[0].type);
  return elements.every((element) => typeName(decayed(element.type)) === typeName(type)) ? type : undefined;
}

/**
 * `std::min({...})`, `std::max({...})`, and `std::minmax({...})`, which return copies of the least and the greatest
 * values of a list, as `min_element`, `max_element`, and `minmax_element` find them. `result` is minmax's pair.
 */
function listExtremum(
  compiler: ExpressionCompiler,
  name: string,
  elements: Expr[],
  type: Type,
  less: (frame: Frame) => Less,
  comparatorParams: Type[],
  result: ClassInfo | undefined
): FunctionInfo {
  const values = elements.map((element) => compiler.copyInitializer(type, element, element.row, true));
  const ops = elementOperations(compiler, type, elements[0].row);
  // The list itself is the argument, which the function evaluates element by element.
  const listParam: Type = { kind: 'function', ret: VOID, params: [] };
  const destroy = ops.destroy;
  const runs = values.map((initialize) => (frame: Frame) => {
    const object = initialize(frame);
    if (destroy) frame.temporaries.push({ object, destroy });
    return object;
  });
  const isConstant =
    comparatorParams.length === 0 && supportsConstantOrder(type) && values.every((value) => value.isConstant);
  return native(
    name,
    [listParam, ...comparatorParams],
    result ? classType(result) : type,
    (_args, { frame }) =>
      holdAll(frame, runs, (values) => {
        const items = values as Value[];
        const compare = less(frame);
        if (result) {
          const [low, high] = minmaxPositions(items, compare);
          const selected: Value[] = [items[low], items[high]];
          return new CObject(
            result,
            makeEach(
              frame,
              selected.length,
              (index) => ops.copy(frame, selected[index]),
              () => destroy
            )
          );
        }
        let best = 0;
        for (let index = 1; index < items.length; index++) {
          if (name === 'min' ? compare(items[index], items[best]) : compare(items[best], items[index])) best = index;
        }
        return ops.copy(frame, items[best]);
      }),
    { libraryConstant: () => (isConstant ? true : undefined) }
  );
}

/** libc++'s `__minmax_element_impl`: the first least and the last greatest, comparing the values in pairs. */
function minmaxPositions(items: Value[], less: Less): [number, number] {
  const length = items.length;
  let low = 0;
  let high = 0;
  if (length < 2) return [low, high];
  let first = 1;
  if (less(items[first], items[low])) low = first;
  else high = first;
  while (++first !== length) {
    const index = first;
    if (++first === length) {
      if (less(items[index], items[low])) low = index;
      else if (!less(items[index], items[high])) high = index;
      return [low, high];
    }
    if (less(items[first], items[index])) {
      if (less(items[first], items[low])) low = first;
      if (!less(items[index], items[high])) high = index;
    } else {
      if (less(items[index], items[low])) low = index;
      if (!less(items[first], items[high])) high = first;
    }
  }
  return [low, high];
}

// libc++'s std::sort ------------------------------------------------------------------------------------------------

function sort3(values: Range, x: number, y: number, z: number, less: Less): void {
  if (!less(values.comparisonValue(y), values.comparisonValue(x))) {
    if (!less(values.comparisonValue(z), values.comparisonValue(y))) return;
    values.swap(y, z);
    if (less(values.comparisonValue(y), values.comparisonValue(x))) values.swap(x, y);
    return;
  }
  if (less(values.comparisonValue(z), values.comparisonValue(y))) {
    values.swap(x, z);
    return;
  }
  values.swap(x, y);
  if (less(values.comparisonValue(z), values.comparisonValue(y))) values.swap(y, z);
}

function sort4(values: Range, a: number, b: number, c: number, d: number, less: Less): void {
  sort3(values, a, b, c, less);
  if (less(values.comparisonValue(d), values.comparisonValue(c))) {
    values.swap(c, d);
    if (less(values.comparisonValue(c), values.comparisonValue(b))) {
      values.swap(b, c);
      if (less(values.comparisonValue(b), values.comparisonValue(a))) values.swap(a, b);
    }
  }
}

function sort5(values: Range, a: number, b: number, c: number, d: number, e: number, less: Less): void {
  sort4(values, a, b, c, d, less);
  if (less(values.comparisonValue(e), values.comparisonValue(d))) {
    values.swap(d, e);
    if (less(values.comparisonValue(d), values.comparisonValue(c))) {
      values.swap(c, d);
      if (less(values.comparisonValue(c), values.comparisonValue(b))) {
        values.swap(b, c);
        if (less(values.comparisonValue(b), values.comparisonValue(a))) values.swap(a, b);
      }
    }
  }
}

function insertionSort(values: Range, first: number, last: number, less: Less, guarded: boolean): void {
  if (first === last) return;
  for (let i = first + 1; i !== last; i++) {
    let j = i - 1;
    if (less(values.comparisonValue(i), values.comparisonValue(j))) {
      values.withTemporary(i, (value) => {
        let k = j;
        j = i;
        do {
          values.set(j, values.get(k));
          j = k;
        } while ((!guarded || j !== first) && less(value, values.comparisonValue(--k)));
        values.set(j, value);
      });
    }
  }
}

function insertionSortIncomplete(values: Range, first: number, last: number, less: Less): boolean {
  switch (last - first) {
    case 0:
    case 1: {
      return true;
    }
    case 2: {
      if (less(values.comparisonValue(last - 1), values.comparisonValue(first))) values.swap(first, last - 1);
      return true;
    }
    case 3: {
      sort3(values, first, first + 1, last - 1, less);
      return true;
    }
    case 4: {
      sort4(values, first, first + 1, first + 2, last - 1, less);
      return true;
    }
    case 5: {
      sort5(values, first, first + 1, first + 2, first + 3, last - 1, less);
      return true;
    }
  }
  let j = first + 2;
  sort3(values, first, first + 1, j, less);
  let count = 0;
  for (let i = j + 1; i !== last; i++) {
    if (less(values.comparisonValue(i), values.comparisonValue(j))) {
      values.withTemporary(i, (value) => {
        let k = j;
        j = i;
        do {
          values.set(j, values.get(k));
          j = k;
        } while (j !== first && less(value, values.comparisonValue(--k)));
        values.set(j, value);
      });
      if (++count === 8) return i + 1 === last;
    }
    j = i;
  }
  return true;
}

function partitionWithEqualsOnRight(values: Range, start: number, end: number, less: Less): [number, boolean] {
  const begin = start;
  let first = start;
  let last = end;
  return values.withTemporary(first, (pivot) => {
    do first++;
    while (less(values.comparisonValue(first), pivot));
    if (begin === first - 1) {
      while (first < last && !less(values.comparisonValue(--last), pivot));
    } else {
      while (!less(values.comparisonValue(--last), pivot));
    }
    const alreadyPartitioned = first >= last;
    while (first < last) {
      values.swap(first, last);
      do first++;
      while (less(values.comparisonValue(first), pivot));
      do last--;
      while (!less(values.comparisonValue(last), pivot));
    }
    const pivotPosition = first - 1;
    if (begin !== pivotPosition) values.set(begin, values.get(pivotPosition));
    values.set(pivotPosition, pivot);
    return [pivotPosition, alreadyPartitioned];
  });
}

function partitionWithEqualsOnLeft(values: Range, start: number, end: number, less: Less): number {
  const begin = start;
  let first = start;
  let last = end;
  return values.withTemporary(first, (pivot) => {
    if (less(pivot, values.comparisonValue(last - 1))) {
      do first++;
      while (!less(pivot, values.comparisonValue(first)));
    } else {
      while (++first < last && !less(pivot, values.comparisonValue(first)));
    }
    if (first < last) {
      do last--;
      while (less(pivot, values.comparisonValue(last)));
    }
    while (first < last) {
      values.swap(first, last);
      do first++;
      while (!less(pivot, values.comparisonValue(first)));
      do last--;
      while (less(pivot, values.comparisonValue(last)));
    }
    const pivotPosition = first - 1;
    if (begin !== pivotPosition) values.set(begin, values.get(pivotPosition));
    values.set(pivotPosition, pivot);
    return first;
  });
}

/** The heap sort that introsort falls back to (`__partial_sort` over the whole range). */
function heapSort(values: Range, first: number, last: number, less: Less): void {
  const length = last - first;
  const siftDown = (start: number, size: number): void => {
    let child = start;
    if (size < 2 || (size - 2) >> 1 < child) return;
    child = 2 * child + 1;
    if (child + 1 < size && less(values.comparisonValue(first + child), values.comparisonValue(first + child + 1)))
      child++;
    if (less(values.comparisonValue(first + child), values.comparisonValue(first + start))) return;
    values.withTemporary(first + start, (top) => {
      let hole = start;
      do {
        values.set(first + hole, values.get(first + child));
        hole = child;
        if ((size - 2) >> 1 < child) break;
        child = 2 * child + 1;
        if (child + 1 < size && less(values.comparisonValue(first + child), values.comparisonValue(first + child + 1)))
          child++;
      } while (!less(values.comparisonValue(first + child), top));
      values.set(first + hole, top);
    });
  };
  for (let start = (length - 2) >> 1; start >= 0; start--) siftDown(start, length);
  for (let size = length; size > 1; size--) {
    values.swap(first, first + size - 1);
    siftDown(0, size - 1);
  }
}

/** The length below which `__introsort` sorts by insertion, the same for every element type. */
const INSERTION_SORT_LIMIT = 24;

/** libc++'s `__introsort` (without the bitset partition, which only arithmetic types with `<` use). */
function introsort(values: Range, less: Less): void {
  const length = values.length;
  if (length < 2) return;
  sortPart(values, 0, length, less, 2 * Math.floor(Math.log2(length)), true);
}

function sortPart(
  values: Range,
  start: number,
  end: number,
  less: Less,
  depthLimit: number,
  isLeftmost: boolean
): void {
  let first = start;
  let last = end;
  let depth = depthLimit;
  let leftmost = isLeftmost;
  for (;;) {
    const length = last - first;
    switch (length) {
      case 0:
      case 1: {
        return;
      }
      case 2: {
        if (less(values.comparisonValue(last - 1), values.comparisonValue(first))) values.swap(first, last - 1);
        return;
      }
      case 3: {
        sort3(values, first, first + 1, last - 1, less);
        return;
      }
      case 4: {
        sort4(values, first, first + 1, first + 2, last - 1, less);
        return;
      }
      case 5: {
        sort5(values, first, first + 1, first + 2, first + 3, last - 1, less);
        return;
      }
    }
    if (length < INSERTION_SORT_LIMIT) {
      insertionSort(values, first, last, less, leftmost);
      return;
    }
    if (depth === 0) {
      heapSort(values, first, last, less);
      return;
    }
    depth--;
    const half = Math.floor(length / 2);
    if (length > 128) {
      sort3(values, first, first + half, last - 1, less);
      sort3(values, first + 1, first + half - 1, last - 2, less);
      sort3(values, first + 2, first + half + 1, last - 3, less);
      sort3(values, first + half - 1, first + half, first + half + 1, less);
      values.swap(first, first + half);
    } else {
      sort3(values, first + half, first, last - 1, less);
    }
    if (!leftmost && !less(values.comparisonValue(first - 1), values.comparisonValue(first))) {
      first = partitionWithEqualsOnLeft(values, first, last, less);
      continue;
    }
    const [pivot, alreadyPartitioned] = partitionWithEqualsOnRight(values, first, last, less);
    if (alreadyPartitioned) {
      const leftSorted = insertionSortIncomplete(values, first, pivot, less);
      if (insertionSortIncomplete(values, pivot + 1, last, less)) {
        if (leftSorted) return;
        last = pivot;
        continue;
      }
      if (leftSorted) {
        first = pivot + 1;
        continue;
      }
    }
    sortPart(values, first, pivot, less, depth, leftmost);
    leftmost = false;
    first = pivot + 1;
  }
}

/** A stable merge sort, whose result `std::stable_sort` guarantees. */
function stableSort(values: Range, less: Less): void {
  const items = Array.from({ length: values.length }, (_, index) => values.take(index));
  const merge = (list: Value[]): Value[] => {
    if (list.length <= 1) return list;
    const middle = list.length >> 1;
    const left = merge(list.slice(0, middle));
    const right = merge(list.slice(middle));
    const result: Value[] = [];
    let i = 0;
    let j = 0;
    while (i < left.length && j < right.length) result.push(less(right[j], left[i]) ? right[j++] : left[i++]);
    return [...result, ...left.slice(i), ...right.slice(j)];
  };
  for (const [index, item] of merge(items).entries()) values.set(index, item);
}

/** Rearranges a range into the next permutation in the order `less`, telling whether one existed. */
function permute(values: Range, less: Less): boolean {
  const length = values.length;
  if (length < 2) return false;
  let i = length - 1;
  for (;;) {
    const ip1 = i;
    i--;
    if (less(values.comparisonValue(i), values.comparisonValue(ip1))) {
      let j = length - 1;
      while (!less(values.comparisonValue(i), values.comparisonValue(j))) j--;
      values.swap(i, j);
      for (let a = ip1, b = length - 1; a < b; a++, b--) values.swap(a, b);
      return true;
    }
    if (i === 0) {
      for (let a = 0, b = length - 1; a < b; a++, b--) values.swap(a, b);
      return false;
    }
  }
}

/** Whether an iterator type is random access: a pointer, or an iterator of a string, a vector, a deque, or an array. */
const isRandomAccess = (type: Type): boolean =>
  type.kind === 'pointer' ||
  (type.kind === 'class' && !/^std::(list|set|multiset|map|multimap|unordered_\w+)</.test(type.cls.name));

const decayed = (type: Type): Type => (type.kind === 'array' ? { kind: 'pointer', to: type.of } : unqualified(type));
