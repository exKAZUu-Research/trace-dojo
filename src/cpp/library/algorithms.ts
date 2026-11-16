import { toInt32 } from '../../c/arith';
import { CompileError } from '../../interpreter/diagnostics';
import { CppRuntimeError } from '../errors';
import type { Expr } from '../expr';
import type { ExpressionCompiler } from '../expressionCompiler';
import type { Frame } from '../runtime';
import {
  BOOL,
  ClassInfo,
  classType,
  type FunctionInfo,
  isArithmetic,
  isConstType,
  isInteger,
  LONG,
  PTRDIFF_T,
  referenceTo,
  SIZE_T,
  type Type,
  typeName,
  unqualified,
  VOID,
  withConst,
} from '../types';
import { CObject, Ptr, type Store, type Value } from '../values';
import { pairClass } from './associative';
import type { SequenceValue } from './containerValues';
import { comparatorOf, elementOperations, equalTo, lessThan, moveValue, truthy } from './elements';
import type { EngineValue } from './random';
import { uniformInteger } from './random';
import type { Library } from './registry';
import { StringValue } from './string';
import { constRef, generic, native } from './support';

/** What an argument's type tells of an iterator: the element it designates, and whether it goes backward. */
interface IteratorInfo {
  element: Type;
  isReverse: boolean;
  isOutput?: boolean;
}

function iteratorInfo(type: Type): IteratorInfo | undefined {
  if (type.kind === 'pointer' && type.to.kind !== 'void') return { element: type.to, isReverse: false };
  if (type.kind === 'class' && type.cls.library?.kind === 'iterator') {
    return { element: type.cls.library.args[0], isReverse: type.cls.library.isReverse === true };
  }
  if (type.kind === 'class' && type.cls.library?.kind === 'back_insert_iterator') {
    return { element: type.cls.library.args[0], isReverse: false, isOutput: true };
  }
  return undefined;
}

/** The elements between two iterators, addressed by their positions from the first. */
class Range {
  readonly store: Store;
  readonly length: number;

  constructor(
    readonly first: Ptr,
    last: Ptr,
    readonly isReverse: boolean
  ) {
    const store = first.target();
    if (last.store !== store) throw new CppRuntimeError('invalidRange');
    this.store = store;
    this.length = isReverse ? first.index - last.index : last.index - first.index;
    if (this.length < 0) throw new CppRuntimeError('invalidRange');
  }

  private index(position: number): number {
    if (position < 0 || position >= this.length) throw new CppRuntimeError('invalidComparator');
    return this.isReverse ? this.first.index - 1 - position : this.first.index + position;
  }

  get(position: number): Value {
    return this.store.get(this.index(position));
  }

  set(position: number, value: Value): void {
    this.store.set(this.index(position), value);
  }

  swap(a: number, b: number): void {
    const value = this.get(a);
    this.set(a, this.get(b));
    this.set(b, value);
  }

  /** The iterator at a position, which may be one past the last element. */
  iterator(position: number): Ptr {
    return new Ptr(this.store, this.isReverse ? this.first.index - position : this.first.index + position);
  }
}

/** Where an output iterator writes: into a range, or at the end of a container through `std::back_inserter`. */
class Output {
  private position = 0;

  constructor(
    private readonly start: Ptr,
    private readonly info: IteratorInfo,
    private readonly frame: Frame,
    private readonly copy: (frame: Frame, value: Value) => Value
  ) {}

  write(value: Value): void {
    if (this.info.isOutput) {
      const target = this.start.read();
      this.frame.runtime.reserve(1);
      if (target instanceof StringValue) target.bytes += String.fromCodePoint(Number(value) & 0xff);
      else (target as SequenceValue).items.push(this.copy(this.frame, value));
      return;
    }
    const index = this.info.isReverse ? this.start.index - 1 - this.position : this.start.index + this.position;
    this.start.target().set(index, this.copy(this.frame, value));
    this.position++;
  }

  get end(): Ptr {
    if (this.info.isOutput) return this.start;
    return new Ptr(
      this.start.store,
      this.info.isReverse ? this.start.index - this.position : this.start.index + this.position
    );
  }
}

type Less = (a: Value, b: Value) => boolean;

/** The function templates of `<algorithm>`, `<numeric>`, `<iterator>`, and `<utility>`. */
// code-gauge-allow functionNcss 400 -- One definition per algorithm, each a few lines.
export function algorithmFunctions(library: Library): Map<string, FunctionInfo[]> {
  const functions = new Map<string, FunctionInfo[]>();
  const compiler = (): ExpressionCompiler => library.compiler;
  const define = (
    name: string,
    instantiate: (args: Expr[], templateArgs: Type[] | undefined) => FunctionInfo | undefined
  ): void => {
    functions.set(name, [...(functions.get(name) ?? []), generic(name, instantiate)]);
  };
  /** The comparison an algorithm uses: the argument at `index`, or `<`. */
  const lessOf = (args: Expr[], index: number, element: Type): ((frame: Frame) => Less) | undefined =>
    orderOf(args[index], [unqualified(element), unqualified(element)]);
  /** The comparison `arg` makes between values of the two types, or `<` without it. */
  const orderOf = (arg: Expr | undefined, types: Type[]): ((frame: Frame) => Less) | undefined => {
    if (!arg) {
      const less = lessThan(types[0]);
      if (!less) return undefined;
      return () => (a, b) => less(a, b) < 0;
    }
    const call = comparatorOf(compiler(), unqualified(arg.type), arg.functions?.candidates, types, arg.row);
    if (!call) return undefined;
    return (frame) => (a, b) => truthy(call(frame, undefined, a, b));
  };
  /** A predicate or an operation argument, for `arity` elements or for arguments of the types `element` lists. */
  const predicateOf = (
    arg: Expr | undefined,
    element: Type | Type[],
    arity = 1
  ): ((frame: Frame, ...values: Value[]) => Value) | undefined => {
    if (!arg) return undefined;
    const types = Array.isArray(element)
      ? element.map((type) => unqualified(type))
      : Array.from({ length: arity }, () => unqualified(element));
    if (arg.functions) {
      const call = comparatorOf(compiler(), VOID, arg.functions.candidates, types, arg.row);
      return call ? (frame, ...values) => call(frame, undefined, ...values) : undefined;
    }
    const type = unqualified(arg.type);
    if (type.kind === 'class' && type.cls.library?.kind === 'functor') {
      const operation = type.cls.library.apply?.(types[0]);
      return operation ? (_frame, a, b) => operation(a, b) : undefined;
    }
    return undefined;
  };

  // Sorting -------------------------------------------------------------------------------------------------------
  for (const name of ['sort', 'stable_sort']) {
    define(name, (args) => {
      const info = rangeAt(args, 0);
      if (!info || args.length > 3 || isConstType(info.element)) return;
      const less = lessOf(args, 2, info.element);
      if (!less)
        return compiler().error(
          args[0].row,
          `${typeName(info.element)} の値は < で比べられません。比べ方を表す関数を渡してください。`
        );
      return native(name, params(args), VOID, ([first, last], { frame }) => {
        const values = range(first, last, info);
        frame.runtime.spend(values.length);
        if (name === 'sort') introsort(values, less(frame));
        else stableSort(values, less(frame));
        return;
      });
    });
  }
  define('reverse', (args) => {
    const info = rangeAt(args, 0);
    if (!info || args.length !== 2) return;
    return native('reverse', params(args), VOID, ([first, last]) => {
      const values = range(first, last, info);
      for (let i = 0, j = values.length - 1; i < j; i++, j--) values.swap(i, j);
      return;
    });
  });
  for (const name of ['next_permutation', 'prev_permutation']) {
    define(name, (args) => {
      const info = rangeAt(args, 0);
      if (!info || args.length > 3) return;
      const less = lessOf(args, 2, info.element);
      if (!less) return;
      return native(name, params(args), BOOL, ([first, last], { frame }) => {
        const values = range(first, last, info);
        const compare = less(frame);
        const ordered = name === 'next_permutation' ? compare : (a: Value, b: Value): boolean => compare(b, a);
        return permute(values, ordered) ? 1 : 0;
      });
    });
  }
  define('shuffle', (args) => {
    const info = rangeAt(args, 0);
    if (!info || args.length !== 3 || args[2].type.kind !== 'class' || args[2].type.cls.library?.kind !== 'engine')
      return;
    return native(
      'shuffle',
      [...params(args).slice(0, 2), referenceTo(args[2].type)],
      VOID,
      ([first, last, engine]) => {
        const values = range(first, last, info);
        const generator = (engine as Ptr).read() as EngineValue;
        // libc++'s shuffle draws with uniform_int_distribution<ptrdiff_t>.
        for (let at = 0, remaining = values.length - 1; at < values.length - 1; at++, remaining--) {
          const offset = Number(uniformInteger(generator, 0n, BigInt(remaining), 64));
          if (offset !== 0) values.swap(at, at + offset);
        }
        return;
      }
    );
  });

  // Searching and counting ------------------------------------------------------------------------------------------
  for (const name of ['min_element', 'max_element']) {
    define(name, (args) => {
      const info = rangeAt(args, 0);
      if (!info || args.length > 3) return;
      const less = lessOf(args, 2, info.element);
      if (!less) return;
      return native(name, params(args), unqualified(args[0].type), ([first, last], { frame }) => {
        const values = range(first, last, info);
        const compare = less(frame);
        let best = 0;
        for (let index = 1; index < values.length; index++) {
          if (
            name === 'min_element'
              ? compare(values.get(index), values.get(best))
              : compare(values.get(best), values.get(index))
          )
            best = index;
        }
        return values.iterator(values.length === 0 ? 0 : best);
      });
    });
  }
  define('find', (args) => {
    const info = rangeAt(args, 0);
    if (!info || args.length !== 3) return;
    const equal = valueEquality(compiler(), info.element, args[2]);
    if (!equal) return;
    return native('find', params(args), unqualified(args[0].type), ([first, last, value]) => {
      const values = range(first, last, info);
      const target = readArg(value, params(args)[2]);
      for (let index = 0; index < values.length; index++)
        if (equal(values.get(index), target)) return values.iterator(index);
      return values.iterator(values.length);
    });
  });
  for (const name of ['find_if', 'find_if_not']) {
    define(name, (args) => {
      const info = rangeAt(args, 0);
      if (!info || args.length !== 3) return;
      const predicate = predicateOf(args[2], info.element);
      if (!predicate) return;
      return native(name, params(args), unqualified(args[0].type), ([first, last], { frame }) => {
        const values = range(first, last, info);
        for (let index = 0; index < values.length; index++) {
          if (truthy(predicate(frame, values.get(index))) === (name === 'find_if')) return values.iterator(index);
        }
        return values.iterator(values.length);
      });
    });
  }
  define('count', (args) => {
    const info = rangeAt(args, 0);
    if (!info || args.length !== 3) return;
    const equal = valueEquality(compiler(), info.element, args[2]);
    if (!equal) return;
    return native('count', params(args), PTRDIFF_T, ([first, last, value]) => {
      const values = range(first, last, info);
      const target = readArg(value, params(args)[2]);
      let count = 0;
      for (let index = 0; index < values.length; index++) if (equal(values.get(index), target)) count++;
      return BigInt(count);
    });
  });
  define('count_if', (args) => {
    const info = rangeAt(args, 0);
    if (!info || args.length !== 3) return;
    const predicate = predicateOf(args[2], info.element);
    if (!predicate) return;
    return native('count_if', params(args), PTRDIFF_T, ([first, last], { frame }) => {
      const values = range(first, last, info);
      let count = 0;
      for (let index = 0; index < values.length; index++) if (truthy(predicate(frame, values.get(index)))) count++;
      return BigInt(count);
    });
  });
  for (const name of ['all_of', 'any_of', 'none_of']) {
    define(name, (args) => {
      const info = rangeAt(args, 0);
      if (!info || args.length !== 3) return;
      const predicate = predicateOf(args[2], info.element);
      if (!predicate) return;
      return native(name, params(args), BOOL, ([first, last], { frame }) => {
        const values = range(first, last, info);
        for (let index = 0; index < values.length; index++) {
          const test = truthy(predicate(frame, values.get(index)));
          if (name === 'all_of' && !test) return 0;
          if (name === 'any_of' && test) return 1;
          if (name === 'none_of' && test) return 0;
        }
        return name === 'any_of' ? 0 : 1;
      });
    });
  }
  for (const name of ['lower_bound', 'upper_bound', 'binary_search']) {
    define(name, (args) => {
      const info = rangeAt(args, 0);
      if (!info || args.length < 3 || args.length > 4) return;
      const valueType = params(args)[2];
      // A comparator may take the element and the value in different types: (element, value) for lower_bound and
      // (value, element) for upper_bound.
      const elementType = unqualified(info.element);
      const searched = unqualified(valueType.kind === 'reference' ? valueType.to : valueType);
      const elementFirst = name !== 'upper_bound' ? orderOf(args[3], [elementType, searched]) : undefined;
      const valueFirst = name !== 'lower_bound' ? orderOf(args[3], [searched, elementType]) : undefined;
      if ((name !== 'upper_bound' && !elementFirst) || (name !== 'lower_bound' && !valueFirst)) return;
      return native(
        name,
        params(args),
        name === 'binary_search' ? BOOL : unqualified(args[0].type),
        ([first, last, value], { frame }) => {
          const values = range(first, last, info);
          const elementLess = elementFirst?.(frame) as Less;
          const valueLess = valueFirst?.(frame) as Less;
          const target = readArg(value, valueType);
          const upper = name === 'upper_bound';
          let low = 0;
          let count = values.length;
          while (count > 0) {
            const step = Math.floor(count / 2);
            const middle = low + step;
            const goesRight = upper ? !valueLess(target, values.get(middle)) : elementLess(values.get(middle), target);
            if (goesRight) {
              low = middle + 1;
              count -= step + 1;
            } else count = step;
          }
          if (name === 'binary_search') return low < values.length && !valueLess(target, values.get(low)) ? 1 : 0;
          return values.iterator(low);
        }
      );
    });
  }
  define('equal', (args) => {
    const info = rangeAt(args, 0);
    if (!info || args.length < 3 || args.length > 5) return;
    const other = iteratorInfo(decayed(args[2].type));
    if (!other) return;
    // equal(first1, last1, first2[, last2][, pred]): a fourth argument is the end of the second range or a predicate.
    const hasEnd = args.length === 5 || (args.length === 4 && rangeAt(args, 2) !== undefined);
    const predicateArg = args[hasEnd ? 4 : 3];
    const predicate = predicateArg ? predicateOf(predicateArg, info.element, 2) : undefined;
    const equal = equalTo(unqualified(info.element));
    if (predicateArg ? !predicate : !equal) return;
    const same = (frame: Frame, a: Value, b: Value): boolean =>
      predicate ? truthy(predicate(frame, a, b)) : (equal as (x: Value, y: Value) => boolean)(a, b);
    // libc++ compares the lengths first only when both ranges are random access.
    const random = isRandomAccess(decayed(args[0].type)) && isRandomAccess(decayed(args[2].type));
    return native('equal', params(args), BOOL, ([first, last, start, end], { frame }) => {
      const values = range(first, last, info);
      const otherLength = hasEnd ? range(start, end, other).length : values.length;
      if (random && otherLength !== values.length) return 0;
      const length = Math.min(values.length, otherLength);
      const others = range(start, (start as Ptr).offset(other.isReverse ? -length : length), other);
      for (let index = 0; index < length; index++) if (!same(frame, values.get(index), others.get(index))) return 0;
      return values.length === otherLength ? 1 : 0;
    });
  });

  // Modifying -------------------------------------------------------------------------------------------------------
  define('fill', (args) => {
    const info = rangeAt(args, 0);
    if (!info || args.length !== 3 || isConstType(info.element)) return;
    const value = tryCompile(() => compiler().convert(args[2], unqualified(info.element), args[2].row));
    if (!value) return;
    const ops = elementOperations(compiler(), unqualified(info.element), args[0].row);
    return native(
      'fill',
      [...params(args).slice(0, 2), unqualified(info.element)],
      VOID,
      ([first, last, item], { frame }) => {
        const values = range(first, last, info);
        for (let index = 0; index < values.length; index++) values.set(index, ops.copy(frame, item as Value));
        return;
      }
    );
  });
  define('iota', (args) => {
    const info = rangeAt(args, 0);
    if (!info || args.length !== 3 || !isArithmetic(unqualified(info.element))) return;
    const element = unqualified(info.element);
    return native('iota', [...params(args).slice(0, 2), element], VOID, ([first, last, start]) => {
      const values = range(first, last, info);
      let current = start as number | bigint;
      for (let index = 0; index < values.length; index++) {
        values.set(index, current);
        current =
          typeof current === 'bigint'
            ? current + 1n
            : element.kind === 'int'
              ? toIntValue(current + 1, element)
              : current + 1;
      }
      return;
    });
  });
  for (const name of ['replace', 'replace_if']) {
    define(name, (args) => {
      const info = rangeAt(args, 0);
      if (!info || args.length !== 4) return;
      const predicate = name === 'replace_if' ? predicateOf(args[2], info.element) : undefined;
      const equal = name === 'replace' ? valueEquality(compiler(), info.element, args[2]) : undefined;
      if (!predicate && !equal) return;
      const ops = elementOperations(compiler(), unqualified(info.element), args[0].row);
      const types = params(args);
      return native(name, types, VOID, ([first, last, old, replacement], { frame }) => {
        const values = range(first, last, info);
        const target = name === 'replace' ? readArg(old, types[2]) : undefined;
        const value = readArg(replacement, types[3]);
        for (let index = 0; index < values.length; index++) {
          const item = values.get(index);
          if (predicate ? truthy(predicate(frame, item)) : (equal as (a: Value, b: Value) => boolean)(item, target))
            values.set(index, ops.copy(frame, value));
        }
        return;
      });
    });
  }
  for (const name of ['remove', 'remove_if', 'unique']) {
    define(name, (args) => {
      const info = rangeAt(args, 0);
      if (!info) return;
      if (name === 'unique' ? args.length > 3 : args.length !== 3) return;
      let keep: (frame: Frame, item: Value, previous: Value | undefined) => boolean;
      if (name === 'remove') {
        const equal = valueEquality(compiler(), info.element, args[2]);
        if (!equal) return;
        const types = params(args);
        keep = (frame, item) => !equal(item, readArg(frame.pending.at(-1) as Ptr, types[2]));
      } else if (name === 'remove_if') {
        const predicate = predicateOf(args[2], info.element);
        if (!predicate) return;
        keep = (frame, item) => !truthy(predicate(frame, item));
      } else {
        const predicate = args[2] ? predicateOf(args[2], info.element, 2) : undefined;
        const equal = equalTo(unqualified(info.element));
        if (!predicate && !equal) return;
        keep = (frame, item, previous) =>
          previous === undefined ||
          !(predicate
            ? truthy(predicate(frame, previous, item))
            : (equal as (a: Value, b: Value) => boolean)(previous, item));
      }
      const element = unqualified(info.element);
      return native(name, params(args), unqualified(args[0].type), ([first, last, value], { frame }) => {
        const values = range(first, last, info);
        frame.pending.push(value as Value);
        try {
          // The kept elements move forward, leaving moved-from elements behind them.
          let out = 0;
          for (let index = 0; index < values.length; index++) {
            const item = values.get(index);
            if (keep(frame, item, out === 0 ? undefined : values.get(out - 1))) {
              if (out !== index) values.set(out, moveValue(frame, element, values.get(out), item));
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
  define('rotate', (args) => {
    const info = rangeAt(args, 0);
    if (!info || args.length !== 3) return;
    return native('rotate', params(args), unqualified(args[0].type), ([first, middle, last]) => {
      const values = range(first, last, info);
      const split = range(first, middle, info).length;
      const items = Array.from({ length: values.length }, (_, index) => values.get(index));
      const rotated = [...items.slice(split), ...items.slice(0, split)];
      for (const [index, item] of rotated.entries()) values.set(index, item);
      return values.iterator(values.length - split);
    });
  });
  define('swap', (args) => {
    if (args.length !== 2 || !args[0].isLvalue || !args[1].isLvalue) return;
    const type = unqualified(args[0].type);
    if (
      typeName(type) !== typeName(unqualified(args[1].type)) ||
      isConstType(args[0].type) ||
      isConstType(args[1].type)
    )
      return;
    if (type.kind === 'class' && type.cls.isNoncopyable) return;
    return native('swap', [referenceTo(type), referenceTo(type)], VOID, ([a, b], { frame }) => {
      const x = a as Ptr;
      const y = b as Ptr;
      if (type.kind === 'class') {
        const ops = type.cls.operations;
        const copy = ops?.copy(frame, x.read()) as Value;
        ops?.assign(frame, x.read(), y.read());
        ops?.assign(frame, y.read(), copy);
        ops?.destroy?.(frame, copy);
      } else {
        const value = x.read();
        x.write(y.read());
        y.write(value);
      }
      return;
    });
  });
  define('iter_swap', (args) => {
    const a = iteratorInfo(unqualified(args[0]?.type ?? VOID));
    if (!a || args.length !== 2) return;
    return native('iter_swap', params(args), VOID, ([x, y]) => {
      const p = x as Ptr;
      const q = y as Ptr;
      const value = p.read();
      p.write(q.read());
      q.write(value);
      return;
    });
  });

  // Copying and transforming ----------------------------------------------------------------------------------------
  for (const name of ['copy', 'copy_if']) {
    define(name, (args) => {
      const info = rangeAt(args, 0);
      const output = outputOf(args[2]);
      if (!info || !output || args.length !== (name === 'copy' ? 3 : 4)) return;
      const predicate = name === 'copy_if' ? predicateOf(args[3], info.element) : undefined;
      if (name === 'copy_if' && !predicate) return;
      const ops = elementOperations(compiler(), unqualified(output.element), args[2].row);
      return native(name, params(args), unqualified(args[2].type), ([first, last, start], { frame }) => {
        const values = range(first, last, info);
        const out = new Output(start as Ptr, output, frame, ops.copy);
        for (let index = 0; index < values.length; index++) {
          const item = values.get(index);
          if (!predicate || truthy(predicate(frame, item))) out.write(item);
        }
        return out.end;
      });
    });
  }
  define('transform', (args) => {
    const info = rangeAt(args, 0);
    if (!info || (args.length !== 4 && args.length !== 5)) return;
    const isBinary = args.length === 5;
    const output = outputOf(args[isBinary ? 3 : 2]);
    const second = isBinary ? iteratorInfo(unqualified(args[2].type)) : undefined;
    if (!output || (isBinary && !second)) return;
    const operation = predicateOf(args[isBinary ? 4 : 3], info.element, isBinary ? 2 : 1);
    if (!operation) return;
    const ops = elementOperations(compiler(), unqualified(output.element), args[0].row);
    return native('transform', params(args), unqualified(args[isBinary ? 3 : 2].type), (values, { frame }) => {
      const [first, last] = values;
      const source = range(first, last, info);
      const others = isBinary
        ? range(
            values[2],
            (values[2] as Ptr).offset(second?.isReverse ? -source.length : source.length),
            second as IteratorInfo
          )
        : undefined;
      const out = new Output(values[isBinary ? 3 : 2] as Ptr, output, frame, ops.copy);
      for (let index = 0; index < source.length; index++) {
        const result = others
          ? operation(frame, source.get(index), others.get(index))
          : operation(frame, source.get(index));
        out.write(result as Value);
      }
      return out.end;
    });
  });
  define('for_each', (args) => {
    const info = rangeAt(args, 0);
    if (!info || args.length !== 3) return;
    const action = predicateOf(args[2], info.element);
    if (!action || !args[2].functions) return;
    const fn = compiler().resolve(
      '関数',
      args[2].functions.candidates,
      [{ type: info.element, isLvalue: true, row: args[2].row, run: () => {} }],
      undefined,
      args[2].row
    ).fn;
    const byReference = fn.params[0]?.type.kind === 'reference';
    return native('for_each', params(args), VOID, ([first, last], { frame }) => {
      const values = range(first, last, info);
      for (let index = 0; index < values.length; index++) {
        if (byReference) {
          // A function taking a reference may change the element in place.
          library.invokeWith(frame, fn, [values.iterator(index)], args[2].row);
        } else action(frame, values.get(index));
      }
      return;
    });
  });

  // Numeric ------------------------------------------------------------------------------------------------------------
  define('accumulate', (args) => {
    const info = rangeAt(args, 0);
    if (!info || (args.length !== 3 && args.length !== 4)) return;
    const initial = args[2];
    const sumType = unqualified(
      initial.type.kind === 'array' ? { kind: 'pointer', to: initial.type.of } : initial.type
    );
    const combine = args[3]
      ? predicateOf(args[3], info.element, 2)
      : accumulateStep(compiler(), sumType, info.element, initial.row);
    if (!combine) return;
    return native(
      'accumulate',
      [...params(args).slice(0, 2), sumType, ...params(args).slice(3)],
      sumType,
      ([first, last, start], { frame }) => {
        const values = range(first, last, info);
        let sum = start as Value;
        for (let index = 0; index < values.length; index++) sum = combine(frame, sum, values.get(index)) as Value;
        return sum;
      }
    );
  });
  define('inner_product', (args) => {
    const info = rangeAt(args, 0);
    const other = args[2] ? iteratorInfo(unqualified(args[2].type)) : undefined;
    if (!info || !other || (args.length !== 4 && args.length !== 6)) return;
    const sumType = unqualified(args[3].type);
    // inner_product(first1, last1, first2, init, op1, op2) sums with op1 the products op2 makes.
    const product =
      args.length === 6
        ? predicateOf(args[5], [info.element, other.element])
        : accumulateStep(compiler(), unqualified(info.element), other.element, args[0].row, '*');
    const add =
      args.length === 6
        ? predicateOf(args[4], [sumType, sumType])
        : product && accumulateStep(compiler(), sumType, unqualified(info.element), args[0].row);
    if (!product || !add) return;
    return native(
      'inner_product',
      [...params(args).slice(0, 3), sumType, ...params(args).slice(4)],
      sumType,
      ([first, last, start, initial], { frame }) => {
        const values = range(first, last, info);
        const others = range(start, (start as Ptr).offset(values.length), other);
        let sum = initial as Value;
        for (let index = 0; index < values.length; index++)
          sum = add(frame, sum, product(frame, values.get(index), others.get(index)) as Value) as Value;
        return sum;
      }
    );
  });
  define('partial_sum', (args) => {
    const info = rangeAt(args, 0);
    const output = outputOf(args[2]);
    if (!info || !output || (args.length !== 3 && args.length !== 4)) return;
    const add = args[3]
      ? predicateOf(args[3], info.element, 2)
      : accumulateStep(compiler(), unqualified(info.element), info.element, args[0].row);
    if (!add) return;
    const ops = elementOperations(compiler(), unqualified(output.element), args[2].row);
    return native('partial_sum', params(args), unqualified(args[2].type), ([first, last, start], { frame }) => {
      const values = range(first, last, info);
      const out = new Output(start as Ptr, output, frame, ops.copy);
      let sum: Value | undefined;
      for (let index = 0; index < values.length; index++) {
        sum = sum === undefined ? values.get(index) : (add(frame, sum, values.get(index)) as Value);
        out.write(sum);
      }
      return out.end;
    });
  });
  for (const name of ['gcd', 'lcm']) {
    define(name, (args) => {
      if (args.length !== 2) return;
      const types = args.map((arg) => unqualified(arg.type));
      if (!types.every((type) => isInteger(type) && type.name !== 'bool')) return;
      const common = compiler().arithmetic(
        '+',
        { ...args[0], isLvalue: false, constant: undefined },
        { ...args[1], isLvalue: false, constant: undefined },
        args[0].row
      ).type;
      return native(name, [common, common], common, ([a, b]) => {
        let x = BigInt(a as number | bigint);
        let y = BigInt(b as number | bigint);
        if (x < 0n) x = -x;
        if (y < 0n) y = -y;
        const gcd = (p: bigint, q: bigint): bigint => (q === 0n ? p : gcd(q, p % q));
        const result = name === 'gcd' ? gcd(x, y) : x === 0n || y === 0n ? 0n : (x / gcd(x, y)) * y;
        return typeof a === 'bigint' ? result : Number(result);
      });
    });
  }

  // min, max, clamp ------------------------------------------------------------------------------------------------
  /** The order of min, max, minmax, or clamp: the comparator argument at `index`, or `<`. */
  const extremumOrder = (args: Expr[], index: number, type: Type): ((frame: Frame) => Less) | undefined =>
    orderOf(args[index], [type, type]);
  for (const name of ['min', 'max', 'minmax']) {
    define(name, (args, templateArgs) => {
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
      return native(name, types, referenceTo(withConst(type)), ([a, b], { frame }) => {
        const x = (a as Ptr).read();
        const y = (b as Ptr).read();
        // Both return the first of equal values (C++20 [alg.min.max]).
        if (name === 'min') return less(frame)(y, x) ? b : a;
        return less(frame)(x, y) ? b : a;
      });
    });
  }
  define('clamp', (args) => {
    if (args.length !== 3 && args.length !== 4) return;
    const type = commonDeduced(args[0], args[1]);
    if (!type || typeName(type) !== typeName(commonDeduced(args[1], args[2]) ?? VOID)) return;
    const less = extremumOrder(args, 3, type);
    if (!less) return;
    return native(
      'clamp',
      [constRef(type), constRef(type), constRef(type), ...params(args).slice(3)],
      referenceTo(withConst(type)),
      ([v, low, high], { frame }) => {
        const compare = less(frame);
        const value = (v as Ptr).read();
        if (compare(value, (low as Ptr).read())) return low;
        if (compare((high as Ptr).read(), value)) return high;
        return v;
      }
    );
  });

  // Iterators ---------------------------------------------------------------------------------------------------------
  for (const name of ['begin', 'end', 'cbegin', 'cend', 'rbegin', 'rend']) {
    define(name, (args) => {
      if (args.length !== 1) return;
      const type = args[0].type;
      if (type.kind === 'array' && args[0].isLvalue && !name.startsWith('r')) {
        const length = type.length ?? 0;
        return native(
          name,
          [referenceTo(type)],
          { kind: 'pointer', to: type.of },
          ([array]) => new Ptr((array as Ptr).read() as Store, name.endsWith('end') ? length : 0)
        );
      }
      if (type.kind !== 'class' || !type.cls.methods.has(name)) return;
      const member =
        (type.cls.methods.get(name) as FunctionInfo[]).find((fn) => fn.isConst === isConstType(type)) ??
        (type.cls.methods.get(name) as FunctionInfo[])[0];
      return native(
        name,
        [isConstType(type) ? constRef(unqualified(type)) : referenceTo(type)],
        member.ret,
        ([object], context) => member.native?.([], { ...context, self: (object as Ptr).read() })
      );
    });
  }
  define('size', (args) => {
    if (args.length !== 1) return;
    const type = args[0].type;
    if (type.kind === 'array') return native('size', [referenceTo(type)], SIZE_T, () => BigInt(type.length ?? 0));
    if (type.kind !== 'class' || !type.cls.methods.has('size')) return;
    const member = (type.cls.methods.get('size') as FunctionInfo[])[0];
    return native('size', [constRef(unqualified(type))], SIZE_T, ([object], context) =>
      member.native?.([], { ...context, self: (object as Ptr).read() })
    );
  });
  for (const name of ['next', 'prev']) {
    define(name, (args) => {
      const info = args[0] ? iteratorInfo(unqualified(args[0].type)) : undefined;
      if (!info || args.length > 2 || (args[1] && !isInteger(unqualified(args[1].type)))) return;
      const type = unqualified(args[0].type);
      return native(
        name,
        [type, LONG],
        type,
        ([it, count]) => {
          const steps = count === undefined ? 1 : Number(count);
          const delta = (name === 'next' ? steps : -steps) * (info.isReverse ? -1 : 1);
          return (it as Ptr).offset(delta);
        },
        { optional: 1 }
      );
    });
  }
  define('advance', (args) => {
    const info = args[0] ? iteratorInfo(unqualified(args[0].type)) : undefined;
    if (!info || args.length !== 2 || !args[0].isLvalue) return;
    return native('advance', [referenceTo(unqualified(args[0].type)), LONG], VOID, ([it, count]) => {
      const location = it as Ptr;
      location.write((location.read() as Ptr).offset(Number(count) * (info.isReverse ? -1 : 1)));
      return;
    });
  });
  define('distance', (args) => {
    const info = rangeAt(args, 0);
    if (!info || args.length !== 2) return;
    return native('distance', params(args), PTRDIFF_T, ([first, last]) => {
      const a = first as Ptr;
      const b = last as Ptr;
      if (a.store !== b.store) throw new CppRuntimeError('invalidRange');
      return BigInt(info.isReverse ? a.index - b.index : b.index - a.index);
    });
  });
  define('back_inserter', (args) => {
    const container = args[0];
    if (args.length !== 1 || !container.isLvalue || container.type.kind !== 'class') return;
    const kind = container.type.cls.library?.kind;
    if (kind !== 'vector' && kind !== 'deque' && kind !== 'list' && kind !== 'string') return;
    const cls = backInserter(library, container.type);
    return native('back_inserter', [referenceTo(container.type)], classType(cls), ([location]) => location);
  });
  return functions;
}

/** The iterator pair at `index` of the arguments, with a common element type, or undefined when it is none. */
const rangeAt = (args: Expr[], index: number): IteratorInfo | undefined => {
  const a = args[index];
  const b = args[index + 1];
  if (!a || !b) return undefined;
  const info = iteratorInfo(decayed(a.type));
  if (!info || info.isOutput) return undefined;
  if (typeName(decayed(a.type)).replace('const_', '') !== typeName(decayed(b.type)).replace('const_', ''))
    return undefined;
  return info;
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

const range = (first: unknown, last: unknown, info: IteratorInfo): Range =>
  new Range(first as Ptr, last as Ptr, info.isReverse);

const readArg = (arg: unknown, type: Type): Value => (type.kind === 'reference' ? (arg as Ptr).read() : (arg as Value));

const tryCompile = <T>(make: () => T): T | undefined => {
  try {
    return make();
  } catch (error) {
    if (error instanceof CompileError) return undefined;
    throw error;
  }
};

const outputOf = (arg: Expr | undefined): IteratorInfo | undefined =>
  arg ? iteratorInfo(unqualified(arg.type)) : undefined;

/** `std::back_insert_iterator<Container>`, an output iterator that appends what an algorithm writes. */
function backInserter(library: Library, container: Type): ClassInfo {
  const key = `back_insert_iterator<${typeName(container)}#${container.kind === 'class' ? container.cls.id : ''}>`;
  const cached = library.instances.get(key);
  if (cached) return cached;
  const cls = new ClassInfo(`std::back_insert_iterator<${typeName(container)}>`, 'class');
  cls.isComplete = true;
  const element = container.kind === 'class' ? (container.cls.library?.args[0] ?? VOID) : VOID;
  cls.library = { kind: 'back_insert_iterator', args: [element], size: 8, align: 8 };
  cls.operations = { copy: (_frame, value) => value, assign: () => {} };
  library.instances.set(key, cls);
  return cls;
}

function toIntValue(value: number, type: Extract<Type, { kind: 'int' }>): number {
  if (type.name === 'uint') return value >>> 0;
  if (type.name === 'int') return toInt32(value);
  return value;
}

/** The common type `T` of two arguments of `const T&` parameters, or undefined when deduction fails. */
function commonDeduced(a: Expr, b: Expr): Type | undefined {
  const x = unqualified(a.type);
  const y = unqualified(b.type);
  if (a.braced || b.braced || a.functions || b.functions || x.kind === 'void') return undefined;
  if (typeName(x) !== typeName(y) || (x.kind === 'class' && y.kind === 'class' && x.cls !== y.cls)) return undefined;
  return x;
}

/** How `==` compares an element with an argument, after converting the argument to the element's type. */
function valueEquality(
  compiler: ExpressionCompiler,
  element: Type,
  arg: Expr
): ((a: Value, b: Value) => boolean) | undefined {
  const type = unqualified(element);
  const argType = unqualified(arg.type);
  if (isArithmetic(type) && isArithmetic(argType)) return (a, b) => Number(a) === Number(b) || a === b;
  if (type.kind === 'class' && type.cls.library?.kind === 'string' && argType.kind === 'pointer') {
    return (a, b) => (a as unknown as { bytes: string }).bytes === readBytes(b as Ptr);
  }
  if (typeName(type) !== typeName(argType)) return undefined;
  void compiler;
  return equalTo(type);
}

function readBytes(pointer: Ptr): string {
  let bytes = '';
  for (let index = pointer.index; ; index++) {
    const value = pointer.store?.get(index) as number;
    if (value === 0) return bytes;
    bytes += String.fromCodePoint(value & 0xff);
  }
}

/** The step of `std::accumulate`: `sum + element` (or another operator) converted back to the sum's type. */
function accumulateStep(
  compiler: ExpressionCompiler,
  sumType: Type,
  element: Type,
  row: number,
  operator = '+'
): ((frame: Frame, sum: Value, item: Value) => Value) | undefined {
  try {
    const sum: Expr = { type: sumType, isLvalue: false, row, run: (frame) => frame.pending.at(-2) as Value };
    const item: Expr = {
      type: unqualified(element),
      isLvalue: false,
      row,
      run: (frame) => frame.pending.at(-1) as Value,
    };
    const combined = compiler.convert(compiler.binary(operator, sum, item, row), sumType, row).run;
    return (frame, total, value) => {
      frame.pending.push(total, value);
      try {
        return combined(frame) as Value;
      } finally {
        frame.pending.pop();
        frame.pending.pop();
      }
    };
  } catch (error) {
    if (error instanceof CompileError) return undefined;
    throw error;
  }
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
  const values = elements.map((element) => compiler.convert(element, type, element.row).run);
  const ops = elementOperations(compiler, type, elements[0].row);
  // The list itself is the argument, which the function evaluates element by element.
  const listParam: Type = { kind: 'function', ret: VOID, params: [] };
  return native(name, [listParam, ...comparatorParams], result ? classType(result) : type, (_args, { frame }) => {
    const items = values.map((value) => value(frame) as Value);
    const compare = less(frame);
    if (result) {
      const [low, high] = minmaxPositions(items, compare);
      return new CObject(result, [ops.copy(frame, items[low]), ops.copy(frame, items[high])]);
    }
    let best = 0;
    for (let index = 1; index < items.length; index++) {
      if (name === 'min' ? compare(items[index], items[best]) : compare(items[best], items[index])) best = index;
    }
    return items[best];
  });
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
  if (!less(values.get(y), values.get(x))) {
    if (!less(values.get(z), values.get(y))) return;
    values.swap(y, z);
    if (less(values.get(y), values.get(x))) values.swap(x, y);
    return;
  }
  if (less(values.get(z), values.get(y))) {
    values.swap(x, z);
    return;
  }
  values.swap(x, y);
  if (less(values.get(z), values.get(y))) values.swap(y, z);
}

function sort4(values: Range, a: number, b: number, c: number, d: number, less: Less): void {
  sort3(values, a, b, c, less);
  if (less(values.get(d), values.get(c))) {
    values.swap(c, d);
    if (less(values.get(c), values.get(b))) {
      values.swap(b, c);
      if (less(values.get(b), values.get(a))) values.swap(a, b);
    }
  }
}

function sort5(values: Range, a: number, b: number, c: number, d: number, e: number, less: Less): void {
  sort4(values, a, b, c, d, less);
  if (less(values.get(e), values.get(d))) {
    values.swap(d, e);
    if (less(values.get(d), values.get(c))) {
      values.swap(c, d);
      if (less(values.get(c), values.get(b))) {
        values.swap(b, c);
        if (less(values.get(b), values.get(a))) values.swap(a, b);
      }
    }
  }
}

function insertionSort(values: Range, first: number, last: number, less: Less, guarded: boolean): void {
  if (first === last) return;
  for (let i = first + 1; i !== last; i++) {
    let j = i - 1;
    if (less(values.get(i), values.get(j))) {
      const value = values.get(i);
      let k = j;
      j = i;
      do {
        values.set(j, values.get(k));
        j = k;
      } while ((!guarded || j !== first) && less(value, values.get(--k)));
      values.set(j, value);
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
      if (less(values.get(last - 1), values.get(first))) values.swap(first, last - 1);
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
    if (less(values.get(i), values.get(j))) {
      const value = values.get(i);
      let k = j;
      j = i;
      do {
        values.set(j, values.get(k));
        j = k;
      } while (j !== first && less(value, values.get(--k)));
      values.set(j, value);
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
  const pivot = values.get(first);
  do first++;
  while (less(values.get(first), pivot));
  if (begin === first - 1) {
    while (first < last && !less(values.get(--last), pivot));
  } else {
    while (!less(values.get(--last), pivot));
  }
  const alreadyPartitioned = first >= last;
  while (first < last) {
    values.swap(first, last);
    do first++;
    while (less(values.get(first), pivot));
    do last--;
    while (!less(values.get(last), pivot));
  }
  const pivotPosition = first - 1;
  if (begin !== pivotPosition) values.set(begin, values.get(pivotPosition));
  values.set(pivotPosition, pivot);
  return [pivotPosition, alreadyPartitioned];
}

function partitionWithEqualsOnLeft(values: Range, start: number, end: number, less: Less): number {
  const begin = start;
  let first = start;
  let last = end;
  const pivot = values.get(first);
  if (less(pivot, values.get(last - 1))) {
    do first++;
    while (!less(pivot, values.get(first)));
  } else {
    while (++first < last && !less(pivot, values.get(first)));
  }
  if (first < last) {
    do last--;
    while (less(pivot, values.get(last)));
  }
  while (first < last) {
    values.swap(first, last);
    do first++;
    while (!less(pivot, values.get(first)));
    do last--;
    while (less(pivot, values.get(last)));
  }
  const pivotPosition = first - 1;
  if (begin !== pivotPosition) values.set(begin, values.get(pivotPosition));
  values.set(pivotPosition, pivot);
  return first;
}

/** The heap sort that introsort falls back to (`__partial_sort` over the whole range). */
function heapSort(values: Range, first: number, last: number, less: Less): void {
  const length = last - first;
  const siftDown = (start: number, size: number): void => {
    let child = start;
    if (size < 2 || (size - 2) >> 1 < child) return;
    child = 2 * child + 1;
    if (child + 1 < size && less(values.get(first + child), values.get(first + child + 1))) child++;
    if (less(values.get(first + child), values.get(first + start))) return;
    const top = values.get(first + start);
    let hole = start;
    do {
      values.set(first + hole, values.get(first + child));
      hole = child;
      if ((size - 2) >> 1 < child) break;
      child = 2 * child + 1;
      if (child + 1 < size && less(values.get(first + child), values.get(first + child + 1))) child++;
    } while (!less(values.get(first + child), top));
    values.set(first + hole, top);
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
        if (less(values.get(last - 1), values.get(first))) values.swap(first, last - 1);
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
    if (!leftmost && !less(values.get(first - 1), values.get(first))) {
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
  const items = Array.from({ length: values.length }, (_, index) => values.get(index));
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
    if (less(values.get(i), values.get(ip1))) {
      let j = length - 1;
      while (!less(values.get(i), values.get(j))) j--;
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
