import type { Span } from './ast';
import type { Constant } from './constants';
import type { FuncEntity, PackageEntity, VarEntity } from './entities';
import type { Eval, Frame } from './runtime';
import type { Selection, Type } from './types';
import type { Pointer, Value } from './values';

/** A compiled expression: what it is, its type, and how to evaluate it. */
export interface Operand {
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
  /** Takes the address, which makes a local variable live in a cell. */
  addressOf?: () => (frame: Frame) => Pointer;
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
    /** Whether the product still fuses when the program runs, for a variable that may be assigned again. */
    enabled?: () => boolean;
    /** Whether both factors are constants to Go's compiler, which computes the product before the program runs. */
    constant?: () => boolean;
  };
  /**
   * Whether Go's compiler knows the value as a constant: a constant, or a local variable defined once from one, which
   * its optimizer propagates. Decided when the program runs, once every assignment is known.
   */
  ssaConstant?: () => boolean;
  /** The variable a name refers to, for marking it used or assigned. */
  variable?: { markUsed(): void; entity?: VarEntity };
}
