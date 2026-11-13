import type { Span } from './ast';
import type { Constant } from './constants';
import type { FuncEntity, PackageEntity, ProductSource, StaticCallee, Temporary, VarEntity } from './entities';
import type { Eval, Frame } from './runtime';
import type { Selection, Type } from './types';
import type { Pointer, Value } from './values';

/** The local storage a value or an address may refer to, which Go's escape analysis follows. */
export interface Storage {
  /** Local variables whose storage the value may share (such as `s[1:]`, `a[:]`, or `&x`). */
  backingVars?: VarEntity[];
  /** A temporary allocation the value may refer to (such as `[]byte(s)`). */
  nonEscaping?: Temporary;
}

/** A compiled expression: what it is, its type, and how to evaluate it. */
export interface Operand extends Storage {
  mode:
    | 'value'
    /** An addressable variable, field, or element, which `store` writes. */
    | 'variable'
    /** `m[k]`, which can be assigned but has no address. */
    | 'mapIndex'
    | 'constant'
    /** A call of a function without results. */
    | 'novalue'
    | 'type'
    | 'builtin'
    | 'package'
    /** A method selected from a value, which only a call may use here. */
    | 'method';
  type: Type;
  span: Span;
  constant?: Constant;
  /** Evaluates the expression; a call with several results returns them as an array. */
  eval: Eval;
  store?: (frame: Frame, value: Value) => void;
  /**
   * Evaluates an assignment destination's operands, returning the writer that later checks the destination (nil
   * pointers, indices out of range, nil maps) and stores, so that a fault happens at its own store, as in Go.
   */
  prepareStore?: (frame: Frame) => (value: Value) => void;
  /**
   * Evaluates the operands of an addressable struct or array as `prepareStore` does, returning what reads its storage
   * after the same checks, for a destination inside it.
   */
  locate?: (frame: Frame) => () => Value;
  /** Reads and writes a map entry while evaluating the map and key expressions only once. */
  mapUpdate?: (frame: Frame, change: (value: Value) => Value) => void;
  /** Resolves a non-constant untyped shift expression once its target type is known. */
  resolveUntyped?: (target: Type) => Operand;
  /** Takes the address, which makes a local variable live in a cell. */
  addressOf?: () => (frame: Frame) => Pointer;
  /** The storage the address of this variable, field, or element refers to. */
  addressStorage?: Storage;
  /**
   * The local variable this variable, field, or array element lies in with no pointer, slice, or map between, which
   * Go's compiler may keep in registers as a whole.
   */
  ssaRoot?: VarEntity;
  /** What the program taking the address of this value, or of a part of it, does to escape analysis. */
  addressTaken?: () => void;
  /** Records a store into this field or element, which writes the array it lives in. */
  onWrite?: () => void;
  /** Evaluates `v, ok` forms: a map index or a type assertion. */
  commaOk?: (frame: Frame) => [Value, boolean];
  builtin?: string;
  package?: PackageEntity;
  /** The function a name refers to, which a call may call directly. */
  func?: FuncEntity;
  method?: { receiver: Operand; selection: Extract<Selection, { kind: 'method' | 'interfaceMethod' }> };
  /** Whether the expression is a call, which the step rules and the "is not used" check need. */
  isCall?: boolean;
  /** Whether the expression only creates an object, as Java's `new` does, for the step rules. */
  createsObject?: boolean;
  /**
   * The factors of a floating-point multiplication, which an addition or subtraction using it fuses into one rounding,
   * as Go's compiler does on arm64.
   */
  product?: {
    left: Eval;
    right: Eval;
    /** Whether the product still reaches the use, for a variable whose definition a loop may replace. */
    enabled?: () => boolean;
    /** Whether both factors are constants to Go's compiler, which computes the product before the program runs. */
    constant?: SsaConstant;
    source: ProductSource;
  };
  /**
   * Whether Go's compiler knows the value as a constant: a constant, a variable whose reaching definition is one
   * (see ssaValues.ts), a parameter or captured variable of an inlined call that the caller knows as one, or the result
   * of an inlined call returning one. Decided when the program runs, once every loop's writes are known, for the frame
   * the value is computed in, which is undefined for the function itself rather than one of its calls.
   */
  ssaConstant?: SsaConstant;
  /** What Go's compiler resolves the value to through names it sees defined once (see `StaticValue`). */
  static?: StaticValue;
  /** How many values the statement's first pass evaluates before this expression's place (`hoistingCalls`). */
  firstPass?: number;
  /** A value that exists only once the code producing it ran (a result of a multi-value call, a range value). */
  callResult?: boolean;
  /** The variable whose definitions reach this use, and which an assignment to it defines. */
  ssaVariable?: VarEntity;
  /** Which definition of the variable reaches this use. */
  ssaVersion?: number;
  /** The variable a name refers to, for marking it used or assigned. */
  variable?: { markUsed(): void; entity?: VarEntity };
}

/**
 * Whether Go's compiler knows a value as a constant, given which parameters and captured variables of the call
 * computing it are constants: undefined for the function itself, or the frame or arguments of a call it inlined.
 */
export type SsaConstant = (params: ConstantParams | undefined) => boolean;

export interface ConstantParams {
  constantParam(index: number): boolean;
  constantCapture?(variable: object): boolean;
}

/**
 * What Go's compiler resolves a value to as ir.StaticValue does, through a local variable it never assigns again or
 * addresses after its one definition and through the single result of a call it inlines: a constant, which converts to
 * an interface as constant data and folds in arithmetic, or a function of the program, whose calls it may inline.
 */
export interface StaticValue {
  constant?: SsaConstant;
  callee?: StaticCallee;
}
