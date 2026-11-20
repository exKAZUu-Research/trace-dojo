import { commonType, promote } from '../../c/types';
import { CompileError } from '../../interpreter/diagnostics';
import { arithmeticOperation, convertNumeric, type NumericValue } from '../arithmetic';
import { CppRuntimeError, overflowError } from '../errors';
import type { Expr } from '../expr';
import type { ExpressionCompiler } from '../expressionCompiler';
import { constructArray, initializeAt, withTemporaries } from '../objectCompiler';
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
  pointerTo,
  PTRDIFF_T,
  referenceTo,
  sameType,
  SIZE_T,
  sizeOf,
  type Type,
  typeName,
  unqualified,
  VOID,
  withConst,
} from '../types';
import {
  ArrayStore,
  Box,
  CObject,
  endLifetime,
  holdValues,
  NULL_PTR,
  Ptr,
  type Store,
  UNINIT,
  type Value,
} from '../values';
import { pairClass } from './associative';
import { sequenceAddress } from './containerValues';
import {
  assignElement,
  type CallbackOperand,
  callbackOperands,
  constructElementFromRvalue,
  destroyElements,
  type ElementOperations,
  elementOperations,
  equalTo,
  functionCallback,
  lessThan,
  moveAssignElement,
  moveValue,
  predicateCallback,
  requireMoveConstruction,
  requireMoves,
  swapElements,
  truthy,
} from './elements';
import { constructPair, pairResult } from './emplacement';
import { elementLocation, POINTER_ITERATOR, randomAccessIterator } from './iterators';
import type { IteratorCategory } from './libraryClass';
import type { EngineValue } from './random';
import { uniformInteger } from './random';
import type { Library } from './registry';
import { elementConstruction } from './sequences';
import type { StringValue } from './string';
import { constRef, generic, native, readCString } from './support';

/** What an argument's type tells of an iterator: the element it designates, its category, and whether it goes backward. */
interface IteratorInfo {
  element: Type;
  reference?: Type;
  category: IteratorCategory;
  isReverse: boolean;
  isOutput?: boolean;
  outputContainer?: Type;
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
      outputContainer: type.cls.library.outputContainer,
    };
  }
  return undefined;
}

function iteratorOperand(info: IteratorInfo): CallbackOperand {
  return info.reference ? { type: info.reference, category: 'prvalue' } : { type: info.element };
}

/** The elements between two iterators, addressed by their positions from the first. */
class Range {
  private readonly count: number;
  private readonly last?: Ptr;

  constructor(
    readonly first: Ptr,
    end: Ptr | number,
    private readonly info: IteratorInfo,
    private readonly frame: Frame,
    private readonly write?: { ops: ElementOperations; move: boolean }
  ) {
    if (typeof end === 'number') {
      first.offset(info.isReverse ? -end : end, true);
      this.count = end;
    } else {
      this.last = end;
      this.count = first.rangeLength(end, info.isReverse);
    }
    this.checkEndpoints();
  }

  get length(): number {
    this.checkEndpoints();
    return this.count;
  }

  private checkEndpoints(): void {
    this.first.checkIterator();
    this.last?.checkIterator();
  }

  private index(position: number): number {
    this.checkEndpoints();
    if (position < 0 || position >= this.count) throw new CppRuntimeError('invalidComparator');
    this.frame.runtime.spend();
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

  set(position: number, value: Value): void {
    if (!this.write) {
      const index = this.index(position);
      this.first.target().set(index, value);
      return;
    }
    const { ops, move } = this.write;
    const frame = this.frame;
    const location = this.location(position);
    if (move) moveAssignElement(frame, location, ops.type, value);
    else assignElement(frame, location, ops, value);
  }

  take(position: number): Value {
    const value = this.get(position);
    if (!this.write) return value;
    const { ops, move } = this.write;
    const frame = this.frame;
    const object = move ? constructElementFromRvalue(frame, ops.type, value) : ops.copy(frame, value);
    if (ops.destroy) frame.temporaries.push({ object, destroy: ops.destroy });
    return object;
  }

  withTemporary<T>(position: number, use: (location: Ptr) => T): T {
    if (!this.write) throw new Error('Sorting requires a writable range');
    const frame = this.frame;
    return withTemporaries(frame, () => {
      frame.runtime.reserve(1);
      const object = new Box(this.take(position), false);
      frame.temporaries.push({ object, destroy: (_frame, value) => endLifetime(value) });
      return use(new AlgorithmLocal(object, 0));
    });
  }

  swap(a: number, b: number): void {
    if (a === b) return;
    if (this.write) {
      swapElements(this.frame, this.location(a), this.location(b), this.write.ops);
    } else {
      const value = this.get(a);
      this.set(a, this.get(b));
      this.set(b, value);
    }
  }

  /** The iterator at a position, which may be one past the last element. */
  iterator(position: number): Ptr {
    this.checkEndpoints();
    if (position === this.count && this.last) return this.last;
    if (position === 0) return this.first;
    return this.first.offset(this.info.isReverse ? -position : position, true);
  }

  checkCopyDestination(start: Ptr, output: IteratorInfo, wholeRange: boolean): void {
    if (this.length === 0 || output.isOutput || start.isNull) return;
    const inputWidth = sizeOf(this.info.element);
    const outputWidth = sizeOf(output.element);
    const input = copyAddress(this.first, inputWidth);
    const destination = copyAddress(start, outputWidth);
    if (input.store !== destination.store) return;
    const inputLength = this.length * inputWidth;
    const inputStart = input.index - (this.info.isReverse ? inputLength : 0);
    const outputLength = (wholeRange ? this.length : 1) * outputWidth;
    const outputStart = destination.index - (output.isReverse ? outputLength : 0);
    if (outputStart < inputStart + inputLength && inputStart < outputStart + outputLength)
      throw new CppRuntimeError('overlappingCopy');
  }
}

function copyAddress(pointer: Ptr, width: number): Ptr['address'] {
  const sequence = sequenceAddress(pointer);
  if (sequence) return { store: sequence.store, index: sequence.index * sizeOf(sequence.store.elementType) };
  return pointer.byteAddress(width);
}

/** Where an output iterator writes: into a range, or at the end of a container through `std::back_inserter`. */
class Output {
  private position = 0;

  constructor(
    private readonly start: Ptr,
    private readonly info: IteratorInfo,
    private readonly frame: Frame,
    private readonly assign: ReturnType<typeof outputAssignment>
  ) {}

  write(value: Value): void {
    this.assign(this.frame, () => this.location(), value);
    this.position++;
  }

  private location(): Ptr {
    if (this.info.isOutput) return this.start;
    const offset = this.info.isReverse ? -this.position : this.position;
    return this.start.offset(offset, true).element(this.info.isReverse);
  }

  get end(): Ptr {
    if (this.info.isOutput || this.position === 0) return this.start;
    return this.start.offset(this.info.isReverse ? -this.position : this.position, true);
  }
}

class AlgorithmLocal extends Ptr {}

type Less = (a: Ptr, b: Ptr) => boolean;

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
  const lessOf = (
    args: Expr[],
    index: number,
    info: IteratorInfo,
    usesStoredValues = false
  ): ((frame: Frame) => Less) | undefined => {
    const compare = args[index];
    if (info.reference && compare && usesStoredValues) return bitIteratorOrder(compiler(), compare, info);
    const operand = iteratorOperand(info);
    return orderOf(compare, [operand, operand], [info.element, info.element], args[0].row);
  };

  const orderOf = (
    arg: Expr | undefined,
    operands: [CallbackOperand, CallbackOperand],
    [left, right]: [Type, Type],
    row: number
  ): ((frame: Frame) => Less) | undefined => {
    if (arg) {
      const call = predicateOf(arg, ...operands);
      return call && ((frame) => (a, b) => truthy(call(frame, a, b)));
    }
    const less = sameType(left, right, false) ? lessThan(left) : undefined;
    if (less) return () => (a, b) => less(a.read(), b.read()) < 0;
    const compare = locationComparison(compiler(), '<', left, right, row);
    return compare && ((frame) => (a, b) => compare(frame, a, b));
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
        if (name === 'sort') introsort(values, less(frame));
        else stableSort(values, less(frame), frame, ops);
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
        const ordered = name === 'next_permutation' ? compare : (a: Ptr, b: Ptr): boolean => compare(b, a);
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
        else frame.runtime.spend();
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
        const values = range(first, last, info, frame);
        const compare = less(frame);
        let best = 0;
        for (let index = 1; index < values.length; index++) {
          if (
            name === 'min_element'
              ? compare(values.location(index), values.location(best))
              : compare(values.location(best), values.location(index))
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
      const values = range(first, last, info, frame);
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
        const values = range(first, last, info, frame);
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
      const values = range(first, last, info, frame);
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
      const values = range(first, last, info, frame);
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
        const values = range(first, last, info, frame);
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
      const keyType = withConst(decayed(args[2].type));
      types[2] = referenceTo(keyType);
      const element = iteratorOperand(info);
      const key = { type: keyType };
      const boundOrder = (elementFirst: boolean): ((frame: Frame) => Less) | undefined =>
        orderOf(
          args[3],
          elementFirst ? [element, key] : [key, element],
          elementFirst ? [info.element, keyType] : [keyType, info.element],
          args[0].row
        );
      const elementFirst = name !== 'upper_bound' ? boundOrder(true) : undefined;
      const valueFirst = name !== 'lower_bound' ? boundOrder(false) : undefined;
      if ((name !== 'upper_bound' && !elementFirst) || (name !== 'lower_bound' && !valueFirst)) return;
      return native(
        name,
        types,
        name === 'binary_search' ? BOOL : unqualified(args[0].type),
        ([first, last, value], { frame }) => {
          const values = range(first, last, info, frame);
          const elementLess = elementFirst?.(frame) as Less;
          const valueLess = valueFirst?.(frame) as Less;
          const target = value as Ptr;
          const upper = name === 'upper_bound';
          let low = 0;
          let count = values.length;
          while (count > 0) {
            const step = Math.floor(count / 2);
            const middle = low + step;
            const goesRight = upper
              ? !valueLess(target, values.location(middle))
              : elementLess(values.location(middle), target);
            if (goesRight) {
              low = middle + 1;
              count -= step + 1;
            } else count = step;
          }
          if (name === 'binary_search') return low < values.length && !valueLess(target, values.location(low)) ? 1 : 0;
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
      const values = range(first, last, info, frame);
      const boundedOther = hasEnd ? range(start, end, other, frame) : undefined;
      const otherLength = boundedOther?.length ?? values.length;
      if (random && otherLength !== values.length) return 0;
      const length = Math.min(values.length, otherLength);
      const others = boundedOther ?? rangeWithLength(start, length, other, frame);
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
      const values = range(first, last, info, frame);
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
    const add = arithmeticOperation('+', incrementType);
    const one = convertNumeric(1, { kind: 'int', name: 'int' }, incrementType);
    return native('iota', params(args), VOID, ([first, last, start], { frame }) => {
      const values = range(first, last, info, frame);
      let current = start as NumericValue;
      for (let index = 0; index < values.length; index++) {
        values.set(index, convertNumeric(current, source, element));
        current = convertNumeric(add(convertNumeric(current, source, incrementType), one), incrementType, source);
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
      if (name === 'replace') types[2] = constRef(decayed(args[2].type));
      types[3] = constRef(decayed(args[3].type));
      const convert = assignmentSource(
        compiler(),
        { type: withConst(nonReference(types[3])) },
        info.element,
        args[3].row
      );
      return native(name, types, VOID, ([first, last, old, replacement], { frame }) => {
        const values = range(first, last, info, frame);
        const value = replacement as Ptr;
        for (let index = 0; index < values.length; index++) {
          if (
            predicate
              ? truthy(predicate(frame, values.location(index)))
              : (equal as ValueEquality).test(frame, values.get(index), (old as Ptr).read())
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
      const types = params(args);
      let keep: (frame: Frame, values: Range, index: number, out: number) => boolean;
      if (name === 'remove') {
        const equal = valueEquality(compiler(), info.element, decayed(args[2].type), args[0].row);
        if (!equal) return;
        types[2] = constRef(decayed(args[2].type));
        keep = (frame, values, index) => !equal.test(frame, values.get(index), (frame.pending.at(-1) as Ptr).read());
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
      return native(name, types, unqualified(args[0].type), ([first, last, value], { frame }) => {
        const values = range(first, last, info, frame);
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
    const iterator = decayed(args[0].type);
    if (!sameType(iterator, decayed(args[2].type))) return;
    const type = unqualified(info.element);
    const ops = elementOperations(compiler(), type, args[0].row, 'swap');
    const trivialAssignment = hasTrivialCopyAssignment(type);
    return native('rotate', params(args), iterator, ([first, middle, last], { frame }) => {
      const values = mutableRange(first, last, info, frame, ops, true);
      const split = range(first, middle, info, frame).length;
      if (split > values.length) throw new CppRuntimeError('invalidRange');
      rotateRange(values, split, info.category, trivialAssignment);
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
      const assign = outputAssignment(compiler(), iteratorOperand(info), output, args[2].row);
      return native(name, params(args), unqualified(args[2].type), ([first, last, start], { frame }) => {
        const values = range(first, last, info, frame);
        values.checkCopyDestination(start as Ptr, output, predicate !== undefined);
        const out = new Output(start as Ptr, output, frame, assign);
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
    const assign = outputAssignment(compiler(), operation, output, args[0].row);
    return native('transform', params(args), unqualified(args[isBinary ? 3 : 2].type), (values, { frame }) => {
      const [first, last] = values;
      const source = range(first, last, info, frame);
      const others = second ? rangeWithLength(values[2], source.length, second, frame) : undefined;
      const out = new Output(values[isBinary ? 3 : 2] as Ptr, output, frame, assign);
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
      const values = range(first, last, info, frame);
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
    requireMoveConstruction(compiler(), sumType, initial.row);
    return native(
      'accumulate',
      [...params(args).slice(0, 2), sumType, ...params(args).slice(3)],
      sumType,
      ([first, last, start], { frame }) => {
        const values = range(first, last, info, frame);
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
    requireMoveConstruction(compiler(), sumType, args[0].row);
    return native(
      'inner_product',
      [...params(args).slice(0, 3), sumType, ...params(args).slice(4)],
      sumType,
      ([first, last, start, initial], { frame }) => {
        const values = range(first, last, info, frame);
        const others = rangeWithLength(start, values.length, other, frame);
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
    const makeInitial = accumulatorInitializer(compiler(), accumulator.ops, iteratorOperand(info), args[0].row);
    const assign = outputAssignment(compiler(), { type: sumType }, output, args[2].row);
    return native('partial_sum', params(args), unqualified(args[2].type), ([first, last, start], { frame }) => {
      const values = range(first, last, info, frame);
      const out = new Output(start as Ptr, output, frame, assign);
      if (values.length === 0) return out.end;
      return withTemporaries(frame, () => {
        const sum = makeInitial(frame, values.location(0));
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
  const extremumOrder = (args: Expr[], index: number, type: Type): ((frame: Frame) => Less) | undefined => {
    const operand = { type: withConst(type) };
    return orderOf(args[index], [operand, operand], [operand.type, operand.type], args[0].row);
  };
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
          less(frame)(b as Ptr, a as Ptr)
            ? pairResult(frame, result, b as Ptr, a as Ptr)
            : pairResult(frame, result, a as Ptr, b as Ptr)
        );
      }
      const fn = native(name, types, referenceTo(withConst(type)), ([a, b], { frame }) => {
        // Both return the first of equal values (C++20 [alg.min.max]).
        if (name === 'min') return less(frame)(b as Ptr, a as Ptr) ? b : a;
        return less(frame)(a as Ptr, b as Ptr) ? b : a;
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
    const hasUserComparator = args[3]?.functions !== undefined;
    return native(
      'clamp',
      [constRef(type), constRef(type), constRef(type), ...params(args).slice(3)],
      referenceTo(withConst(type)),
      ([v, low, high], { frame }) => {
        const compare = less(frame);
        const lower = low as Ptr;
        const upper = high as Ptr;
        if (!hasUserComparator && compare(upper, lower)) throw new CppRuntimeError('invalidRange');
        const value = v as Ptr;
        if (compare(value, lower)) {
          if (value.equals(upper)) throw new CppRuntimeError('invalidRange');
          return low;
        }
        if (compare(upper, value)) {
          if (value.equals(lower)) throw new CppRuntimeError('invalidRange');
          return high;
        }
        return v;
      }
    );
  });

  // Iterators ---------------------------------------------------------------------------------------------------------
  for (const name of ['begin', 'end', 'cbegin', 'cend', 'rbegin', 'rend']) {
    define(name, [[0]], (args) => {
      if (args.length !== 1) return;
      const type = args[0].type;
      if (type.kind === 'array' && args[0].isLvalue) return arrayRangeFunction(library, name, type);
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
        ([it, count]) => advanceIterator(it as Ptr, info, (name === 'next' ? 1 : -1) * Number(count ?? 1)),
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
        location.write(advanceIterator(location.read() as Ptr, info, Number(count)));
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
      if (info.category !== 'randomAccess') return BigInt(a.rangeLength(b, info.isReverse));
      if (!a.sharesRange(b)) throw new CppRuntimeError('invalidRange');
      if (!a.isNull) a.target();
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

function advanceIterator(iterator: Ptr, info: IteratorInfo, steps: number): Ptr {
  if (steps < 0 && info.category === 'forward') throw new CppRuntimeError('invalidIterator');
  return iterator.offset(info.isReverse ? -steps : steps, true);
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
  info: IteratorInfo
): ((frame: Frame) => Less) | undefined {
  const proxy = iteratorOperand(info);
  const local = { type: info.element };
  const bind = (left: CallbackOperand, right: CallbackOperand): ReturnType<typeof predicateCallback> =>
    predicateCallback(compiler, unqualified(arg.type), arg.functions, [left, right], arg.row);
  const twoProxies = bind(proxy, proxy);
  const proxyLeft = bind(proxy, local);
  const proxyRight = bind(local, proxy);
  const twoLocals = bind(local, local);
  if (!twoProxies || !proxyLeft || !proxyRight || !twoLocals) return;
  return (frame) => (a, b) => {
    const compare =
      a instanceof AlgorithmLocal
        ? b instanceof AlgorithmLocal
          ? twoLocals
          : proxyRight
        : b instanceof AlgorithmLocal
          ? proxyLeft
          : twoProxies;
    return truthy(compare(frame, a, b));
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

function rotateRange(values: Range, split: number, category: IteratorCategory, trivialAssignment: boolean): void {
  const right = values.length - split;
  if (split === 0 || right === 0) return;
  if (trivialAssignment) {
    if (split === 1) return rotateOne(values, 0, values.length - 1, 1);
    if (right === 1 && category !== 'forward') return rotateOne(values, values.length - 1, 0, -1);
    if (category === 'randomAccess') return rotateBlocks(values, split, right);
  }
  rotateForward(values, split);
}

function rotateOne(values: Range, from: number, to: number, direction: 1 | -1): void {
  values.withTemporary(from, (saved) => {
    for (let index = from; index !== to; index += direction) values.set(index, values.get(index + direction));
    values.set(to, saved.read());
  });
}

function rotateBlocks(values: Range, left: number, right: number): void {
  let first = 0;
  while (left > 0 && right > 0) {
    const count = Math.min(left, right);
    const middle = first + left;
    for (let index = 0; index < count; index++) values.swap(middle - count + index, middle + index);
    if (left <= right) {
      first += left;
      right -= left;
    } else left -= right;
  }
}

function rotateForward(values: Range, middle: number): void {
  let first = 0;
  let next = middle;
  while (next < values.length) {
    values.swap(first++, next++);
    if (first === middle) middle = next;
  }
  next = middle;
  while (next < values.length) {
    values.swap(first++, next++);
    if (first === middle) middle = next;
    else if (next === values.length) next = middle;
  }
}

function arrayRangeFunction(library: Library, name: string, type: Extract<Type, { kind: 'array' }>): FunctionInfo {
  const reverse = name.startsWith('r');
  const element = name.startsWith('c') ? withConst(type.of) : type.of;
  const result = reverse
    ? classType(randomAccessIterator(library.iterators, undefined, element, false, true, POINTER_ITERATOR))
    : pointerTo(element);
  const index = name.endsWith('end') === reverse ? 0 : (type.length ?? 0);
  return native(name, [referenceTo(type)], result, ([array]) => new Ptr((array as Ptr).read() as Store, index));
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

const range = (first: unknown, last: unknown, info: IteratorInfo, frame: Frame): Range =>
  new Range(first as Ptr, last as Ptr, info, frame);

function rangeWithLength(begin: unknown, length: number, info: IteratorInfo, frame: Frame): Range {
  return new Range(begin as Ptr, length, info, frame);
}

function mutableRange(
  first: unknown,
  last: unknown,
  info: IteratorInfo,
  frame: Frame,
  ops: ElementOperations,
  move = false
): Range {
  const write = move || info.element.kind === 'class' ? { ops, move } : undefined;
  return new Range(first as Ptr, last as Ptr, info, frame, write);
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
  cls.library = { kind: 'back_insert_iterator', args: [element], size: 8, align: 8, outputContainer: container };
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
    const compare = arithmeticOperation('==', promoted);
    return {
      test: (frame, a, b) => {
        frame.runtime.spend();
        return (
          compare(
            convertNumeric(a as NumericValue, type, promoted),
            convertNumeric(b as NumericValue, argType, promoted)
          ) === 1
        );
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
    const compare = locationComparison(compiler, '==', type, argType, row);
    return compare
      ? { test: (frame, a, b) => compare(frame, new Box(a, false).location(0), new Box(b, false).location(0)) }
      : undefined;
  }
  return {
    test: (frame, a, b) => {
      frame.runtime.spend();
      return equal(a, b);
    },
  };
}

function locationComparison(
  compiler: ExpressionCompiler,
  operator: '<' | '==',
  left: Type,
  right: Type,
  row: number
): ((frame: Frame, left: Ptr, right: Ptr) => boolean) | undefined {
  const operation = binaryStep(compiler, operator, [{ type: left }, { type: right }], row);
  if (!operation) return;
  return (frame, a, b) => {
    frame.runtime.spend();
    return truthy(operation.run(frame, a, b));
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

function outputAssignment(compiler: ExpressionCompiler, operand: CallbackOperand, output: IteratorInfo, row: number) {
  const active: { destination: () => Ptr; value: Value }[] = [];
  const container = output.outputContainer;
  const [target, source] = callbackOperands([{ type: container ?? output.element }, operand], row, (_frame, index) =>
    index === 0 ? active.at(-1)?.destination() : active.at(-1)?.value
  );
  const { run } = compiler.withLibraryAccess(() => {
    if (!container) return compiler.assign('=', target, source, row);
    const argument = compiler.convert(source, constRef(output.element), row);
    return compiler.callWith(compiler.member(target, 'push_back', row), [argument], row);
  });
  return (frame: Frame, destination: () => Ptr, value: Value): void => {
    active.push({ destination, value });
    try {
      withTemporaries(frame, () => run(frame));
    } finally {
      active.pop();
    }
  };
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
  const ops = elementOperations(compiler, type, row);
  compiler.requireLibraryObjectUse(type, 'destroy', row);
  const movesResult =
    operation.category !== undefined && !isConstType(operation.type) && sameType(operation.type, type, false);
  if (movesResult) {
    compiler.requireLibraryObjectUse(type, 'move-assign', row);
    return {
      ops,
      update: (frame, sum, operand) =>
        moveAssignElement(
          frame,
          sum,
          type,
          readOperandValue(operation, invokeOperation(frame, operation, sum, operand))
        ),
    };
  }
  compiler.requireLibraryObjectUse(type, 'assign', row);
  const convert = assignmentSource(compiler, operation, type, row);
  return {
    ops,
    update: (frame, sum, operand) => {
      const result = invokeOperation(frame, operation, sum, operand);
      convert(frame, result, (converted) => assignElement(frame, sum, ops, converted));
    },
  };
}

function accumulatorInitializer(
  compiler: ExpressionCompiler,
  ops: ElementOperations,
  operand: CallbackOperand,
  row: number
): (frame: Frame, source: Ptr) => Ptr {
  const [argument] = callbackOperands([operand], row, (frame) => frame.pending.at(-1));
  const { run } = elementConstruction(compiler, ops.type, [argument], row);
  return (frame, source) => {
    const storage = new Box();
    const location = storage.location(0);
    holdValues(frame, [storage, source], () =>
      initializeAt(
        frame,
        ops.type,
        location,
        UNINIT,
        (target) => run(frame, false, target instanceof CObject ? target : undefined) as Value
      )
    );
    return holdAccumulator(frame, ops, storage);
  };
}

function foldValues(
  frame: Frame,
  accumulator: NumericAccumulator,
  initial: Value,
  length: number,
  item: (index: number) => OperationArgument
): Value {
  const sum = holdAccumulator(frame, accumulator.ops, new Box(initial));
  for (let index = 0; index < length; index++) {
    withTemporaries(frame, () => accumulator.update(frame, sum, item(index)));
  }
  return constructElementFromRvalue(frame, accumulator.ops.type, sum.read());
}

function holdAccumulator(frame: Frame, ops: ElementOperations, storage: Box): Ptr {
  frame.temporaries.push({
    object: storage,
    destroy: (current) => {
      ops.destroy?.(current, storage.value);
      endLifetime(storage);
    },
  });
  return storage.location(0);
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
  const isConstant =
    comparatorParams.length === 0 && supportsConstantOrder(type) && values.every((value) => value.isConstant);
  return native(
    name,
    [listParam, ...comparatorParams],
    result ? classType(result) : type,
    (_args, { frame }) => {
      const items = constructArray(
        frame,
        values.length,
        type,
        (current, target, index) => values[index](current, target, false, 'full-expression'),
        destroy
      );
      frame.temporaries.push({
        object: items,
        destroy: (current) => {
          destroyElements(current, items.values, destroy, 'reverse');
          endLifetime(items);
        },
      });
      const lessAt = less(frame);
      const compare = (first: number, second: number): boolean => lessAt(items.location(first), items.location(second));
      if (result) {
        const [low, high] = minmaxPositions(items.length, compare);
        return constructPair(
          frame,
          result,
          [(f, target) => ops.copy(f, items.get(low), target), (f, target) => ops.copy(f, items.get(high), target)],
          () => destroy
        );
      }
      let best = 0;
      for (let index = 1; index < items.length; index++) {
        if (name === 'min' ? compare(index, best) : compare(best, index)) best = index;
      }
      return ops.copy(frame, items.get(best));
    },
    { libraryConstant: () => (isConstant ? true : undefined) }
  );
}

/** libc++'s `__minmax_element_impl`: the first least and the last greatest, comparing the values in pairs. */
function minmaxPositions(length: number, less: (a: number, b: number) => boolean): [number, number] {
  let low = 0;
  let high = 0;
  if (length < 2) return [low, high];
  let first = 1;
  if (less(first, low)) low = first;
  else high = first;
  while (++first !== length) {
    const index = first;
    if (++first === length) {
      if (less(index, low)) low = index;
      else if (!less(index, high)) high = index;
      return [low, high];
    }
    if (less(first, index)) {
      if (less(first, low)) low = first;
      if (!less(index, high)) high = index;
    } else {
      if (less(index, low)) low = index;
      if (!less(first, high)) high = first;
    }
  }
  return [low, high];
}

// libc++'s std::sort ------------------------------------------------------------------------------------------------

function sort3(values: Range, x: number, y: number, z: number, less: Less): void {
  if (!less(values.location(y), values.location(x))) {
    if (!less(values.location(z), values.location(y))) return;
    values.swap(y, z);
    if (less(values.location(y), values.location(x))) values.swap(x, y);
    return;
  }
  if (less(values.location(z), values.location(y))) {
    values.swap(x, z);
    return;
  }
  values.swap(x, y);
  if (less(values.location(z), values.location(y))) values.swap(y, z);
}

function sort4(values: Range, a: number, b: number, c: number, d: number, less: Less): void {
  sort3(values, a, b, c, less);
  if (less(values.location(d), values.location(c))) {
    values.swap(c, d);
    if (less(values.location(c), values.location(b))) {
      values.swap(b, c);
      if (less(values.location(b), values.location(a))) values.swap(a, b);
    }
  }
}

function sort5(values: Range, a: number, b: number, c: number, d: number, e: number, less: Less): void {
  sort4(values, a, b, c, d, less);
  if (less(values.location(e), values.location(d))) {
    values.swap(d, e);
    if (less(values.location(d), values.location(c))) {
      values.swap(c, d);
      if (less(values.location(c), values.location(b))) {
        values.swap(b, c);
        if (less(values.location(b), values.location(a))) values.swap(a, b);
      }
    }
  }
}

function insertionSort(values: Range, first: number, last: number, less: Less, guarded: boolean): void {
  if (first === last) return;
  for (let i = first + 1; i !== last; i++) {
    let j = i - 1;
    if (less(values.location(i), values.location(j))) {
      values.withTemporary(i, (value) => {
        let k = j;
        j = i;
        do {
          values.set(j, values.get(k));
          j = k;
        } while ((!guarded || j !== first) && less(value, values.location(--k)));
        values.set(j, value.read());
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
      if (less(values.location(last - 1), values.location(first))) values.swap(first, last - 1);
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
    if (less(values.location(i), values.location(j))) {
      values.withTemporary(i, (value) => {
        let k = j;
        j = i;
        do {
          values.set(j, values.get(k));
          j = k;
        } while (j !== first && less(value, values.location(--k)));
        values.set(j, value.read());
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
    while (less(values.location(first), pivot));
    if (begin === first - 1) {
      while (first < last && !less(values.location(--last), pivot));
    } else {
      while (!less(values.location(--last), pivot));
    }
    const alreadyPartitioned = first >= last;
    while (first < last) {
      values.swap(first, last);
      do first++;
      while (less(values.location(first), pivot));
      do last--;
      while (!less(values.location(last), pivot));
    }
    const pivotPosition = first - 1;
    if (begin !== pivotPosition) values.set(begin, values.get(pivotPosition));
    values.set(pivotPosition, pivot.read());
    return [pivotPosition, alreadyPartitioned];
  });
}

function partitionWithEqualsOnLeft(values: Range, start: number, end: number, less: Less): number {
  const begin = start;
  let first = start;
  let last = end;
  return values.withTemporary(first, (pivot) => {
    if (less(pivot, values.location(last - 1))) {
      do first++;
      while (!less(pivot, values.location(first)));
    } else {
      while (++first < last && !less(pivot, values.location(first)));
    }
    if (first < last) {
      do last--;
      while (less(pivot, values.location(last)));
    }
    while (first < last) {
      values.swap(first, last);
      do first++;
      while (!less(pivot, values.location(first)));
      do last--;
      while (less(pivot, values.location(last)));
    }
    const pivotPosition = first - 1;
    if (begin !== pivotPosition) values.set(begin, values.get(pivotPosition));
    values.set(pivotPosition, pivot.read());
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
    if (child + 1 < size && less(values.location(first + child), values.location(first + child + 1))) child++;
    if (less(values.location(first + child), values.location(first + start))) return;
    values.withTemporary(first + start, (top) => {
      let hole = start;
      do {
        values.set(first + hole, values.get(first + child));
        hole = child;
        if ((size - 2) >> 1 < child) break;
        child = 2 * child + 1;
        if (child + 1 < size && less(values.location(first + child), values.location(first + child + 1))) child++;
      } while (!less(values.location(first + child), top));
      values.set(first + hole, top.read());
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
        if (less(values.location(last - 1), values.location(first))) values.swap(first, last - 1);
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
    if (!leftmost && !less(values.location(first - 1), values.location(first))) {
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

function stableSort(values: Range, less: Less, frame: Frame, ops: ElementOperations): void {
  const threshold = hasTrivialCopyAssignment(ops.type) ? 128 : 0;
  const length = values.length;
  if (length <= Math.max(2, threshold)) {
    stableSortSmall(values, 0, length, less);
    return;
  }
  frame.runtime.reserve(length);
  const storage = new ArrayStore(
    Array.from({ length }, (): Value => UNINIT),
    ops.type
  );
  withTemporaries(frame, () => {
    frame.temporaries.push({ object: storage, destroy: (_frame, object) => endLifetime(object) });
    const buffer = new StableSortBuffer(frame, storage, ops);
    stableSortRange(values, 0, length, less, buffer, threshold);
  });
}

function hasTrivialCopyAssignment(type: Type): boolean {
  if (type.kind === 'array') return type.length === 0 || hasTrivialCopyAssignment(type.of);
  if (type.kind !== 'class') return type.kind !== 'reference' && !isConstType(type);
  const { cls } = type;
  const array = cls.library?.aggregateArray;
  if (array) return hasTrivialCopyAssignment(array.type);
  return (
    !cls.library &&
    !cls.isAssignmentDeleted &&
    cls.virtuals.size === 0 &&
    (!cls.base || hasTrivialCopyAssignment(classType(cls.base))) &&
    cls.ownFields.every(({ type: fieldType }) => hasTrivialCopyAssignment(fieldType))
  );
}

function stableSortSmall(values: Range, first: number, last: number, less: Less): void {
  const length = last - first;
  if (length < 2) return;
  if (length === 2) {
    if (less(values.location(first + 1), values.location(first))) values.swap(first, first + 1);
    return;
  }
  insertionSort(values, first, last, less, true);
}

function stableSortRange(
  values: Range,
  first: number,
  last: number,
  less: Less,
  buffer: StableSortBuffer,
  threshold: number
): void {
  const length = last - first;
  if (length <= Math.max(2, threshold)) {
    stableSortSmall(values, first, last, less);
    return;
  }
  const middle = first + Math.floor(length / 2);
  buffer.withConstructedRange(first, last, () => {
    stableSortIntoBuffer(values, first, middle, less, buffer, threshold);
    stableSortIntoBuffer(values, middle, last, less, buffer, threshold);
    mergeStableRuns(
      first,
      middle,
      last,
      less,
      (index) => buffer.location(index),
      (target, source) => values.set(target, source.read())
    );
  });
}

function stableSortIntoBuffer(
  values: Range,
  first: number,
  last: number,
  less: Less,
  buffer: StableSortBuffer,
  threshold: number
): void {
  const length = last - first;
  if (length <= 2) {
    const swap = length === 2 && less(values.location(first + 1), values.location(first));
    buffer.construct(first, values.location(swap ? first + 1 : first));
    if (length === 2) buffer.construct(first + 1, values.location(swap ? first : first + 1));
    return;
  }
  if (length <= 8) {
    buffer.construct(first, values.location(first));
    for (let index = first + 1; index < last; index++) {
      const input = values.location(index);
      if (!less(input, buffer.location(index - 1))) {
        buffer.construct(index, input);
        continue;
      }
      buffer.construct(index, buffer.location(index - 1));
      let position = index - 1;
      while (position > first && less(input, buffer.location(position - 1))) {
        buffer.assign(position, buffer.location(position - 1));
        position--;
      }
      buffer.assign(position, input);
    }
    return;
  }
  const middle = first + Math.floor(length / 2);
  stableSortRange(values, first, middle, less, buffer, threshold);
  stableSortRange(values, middle, last, less, buffer, threshold);
  mergeStableRuns(
    first,
    middle,
    last,
    less,
    (index) => values.location(index),
    (target, source) => buffer.construct(target, source)
  );
}

function mergeStableRuns(
  first: number,
  middle: number,
  last: number,
  less: Less,
  locate: (index: number) => Ptr,
  put: (index: number, source: Ptr) => void
): void {
  let left = first;
  let right = middle;
  for (let out = first; out < last; out++) {
    const fromRight = right < last && (left >= middle || less(locate(right), locate(left)));
    put(out, locate(fromRight ? right++ : left++));
  }
}

class StableSortBuffer {
  constructor(
    private readonly frame: Frame,
    private readonly storage: ArrayStore,
    private readonly ops: ElementOperations
  ) {}

  location(index: number): Ptr {
    return new AlgorithmLocal(this.storage, index);
  }

  construct(index: number, source: Ptr): void {
    const { frame, storage, ops } = this;
    initializeAt(frame, ops.type, storage.location(index), storage.values[index], (target) =>
      constructElementFromRvalue(frame, ops.type, source.read(), target)
    );
  }

  assign(index: number, source: Ptr): void {
    moveAssignElement(this.frame, this.storage.location(index), this.ops.type, source.read());
  }

  withConstructedRange(first: number, last: number, run: () => void): void {
    withTemporaries(this.frame, () => {
      this.frame.temporaries.push({
        object: this.storage,
        destroy: (frame) => {
          for (let index = first; index < last; index++) {
            const value = this.storage.values[index];
            if (value !== UNINIT) this.ops.destroy?.(frame, value);
            this.storage.values[index] = UNINIT;
          }
        },
      });
      run();
    });
  }
}

/** Rearranges a range into the next permutation in the order `less`, telling whether one existed. */
function permute(values: Range, less: Less): boolean {
  const length = values.length;
  if (length < 2) return false;
  let i = length - 1;
  for (;;) {
    const ip1 = i;
    i--;
    if (less(values.location(i), values.location(ip1))) {
      let j = length - 1;
      while (!less(values.location(i), values.location(j))) j--;
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
