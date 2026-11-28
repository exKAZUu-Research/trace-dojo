import type { Expr, Pattern, Span } from './ast';
import type { Known } from './constLint';
import type { ProjectedCapture } from './loanCaptures';
import type { AdtDef, ClosureType, ConstDef, DerefKind, FnDef, TraitRef, Type, TypeParam } from './types';

export interface LocalVar {
  name: string;
  mutable: boolean;
  type: Type;
  slot: number;
  span: Span;
  owner: FnContext;
  isSelf?: boolean;
  mode: 'move' | 'ref' | 'refMut';
}

export interface FnContext {
  name: string;
  locals: LocalVar[];
  slotCount: number;
  /** The variables of enclosing functions a closure uses, in the order of its captures. */
  captures: LocalVar[];
  parent: FnContext | undefined;
  isClosure: boolean;
  isAtomic: boolean;
  isMove: boolean;
  closureKind: 'Fn' | 'FnMut' | 'FnOnce';
  /** For a closure, the captured variables it moves out, which it captures by value even without `move`. */
  movedCaptures?: LocalVar[];
  projectedCaptures?: Map<LocalVar, ProjectedCapture[]>;
  reborrowedCaptures?: Set<LocalVar>;
}

export type PathRes =
  | { kind: 'local'; local: LocalVar }
  /** A captured variable of an enclosing function, by its index among the closure's captures. */
  | { kind: 'capture'; local: LocalVar; index: number }
  | { kind: 'fn'; fn: FnDef; typeArgs: Type[] }
  | { kind: 'ctor'; def: AdtDef; variant: number; typeArgs: Type[] }
  | { kind: 'const'; def: ConstDef; type: Type; typeArgs: Type[] }
  | { kind: 'builtinConst'; type: Type; name: string }
  /** `_` on the left of an assignment. */
  | { kind: 'discard' }
  | { kind: 'constParam'; param: TypeParam; type: Type };

/** How a method call reaches its receiver: through derefs, then by reference or by value. */
export interface ReceiverAdjust {
  /** The derefs from the receiver expression's type, each of a reference (`ref`/`mutRef`) or of an owner. */
  derefs: DerefKind[];
  autoref: 'none' | 'ref' | 'mut';
  /** A receiver used as the iterator it makes: a range, or a type parameter bounded by `Iterator` or `IntoIterator`. */
  asIter: boolean;
}

export interface MethodRes {
  fn: FnDef;
  /** The types of `fn.params`, in order. */
  typeArgs: Type[];
  receiver: ReceiverAdjust;
}

export interface FieldRes {
  derefs: DerefKind[];
  index: number;
  /** `Range`'s fields live on a `RangeValue`. */
  range: boolean;
}

export type Coercion =
  /** References that reach the same value: `&String` → `&str`, `&Box<T>` → `&T`, `&&T` → `&T`. */
  | { kind: 'deref'; derefs: DerefKind[]; fromMut: boolean; toStr: boolean }
  /**
   * `shared`: an `Rc` or `Arc` becomes one of a trait object, sharing its counts; `throughCell`: the trait object is in a
   * `RefCell` or a lock the pointer holds.
   */
  | { kind: 'dyn'; type: Type; mutable: boolean; trait: TraitRef; shared?: boolean; throughCell?: boolean }
  | { kind: 'intoIter'; from: Type }
  | { kind: 'rawPtr' };

export interface IndexRes {
  /** `user`: a type with an impl of `Index` (and `IndexMut`) that the program writes. */
  container: 'slice' | 'str' | 'map' | 'vecDeque' | 'user';
  /** For a `user` container, the type that implements `Index`, and the index's type. */
  implTypes?: [Type, Type];
  range: boolean;
  /** Whether a library type's `Index` impl indexes it (a `Vec`), whose panics report the `[`'s position. */
  overloaded: boolean;
  derefs: DerefKind[];
}

export interface TryRes {
  kind: 'result' | 'option';
  /** The conversion `?` applies to an error: `From::from` from the error's type to the function's. */
  errorFrom: Type | undefined;
  errorTo: Type | undefined;
}

export interface ClosureInfo {
  context: FnContext;
  params: LocalVar[];
}

/** What the type checker learned about a function body, which the borrow checker and the compiler read. */
export class Annotations {
  readonly paths = new Map<Expr | Pattern, PathRes>();
  readonly constPatterns = new Map<Pattern, Known | undefined>();
  readonly unevaluatedRepeatOperands = new Set<Expr | Pattern>();
  readonly functionInitializers = new Map<Expr, LocalVar | undefined>();
  readonly methods = new Map<Expr, MethodRes>();
  /** Operators on types whose impls of the operator traits (`Add`, `Neg`, `AddAssign`, ...) the program writes. */
  readonly operators = new Map<Expr, { fn: FnDef; typeArgs: Type[] }>();
  readonly fields = new Map<Expr, FieldRes>();
  readonly coercions = new Map<Expr, Coercion>();
  readonly indexes = new Map<Expr, IndexRes>();
  readonly tries = new Map<Expr, TryRes>();
  readonly closures = new Map<Expr, ClosureInfo>();
  readonly bindings = new Map<Pattern, LocalVar>();
  readonly reborrows = new Map<Expr, boolean>();
  /** For a call through a variable or a field that holds a closure, the closure trait it uses. */
  readonly callKinds = new Map<Expr, ClosureType['kind']>();
  /** `for` loops: the element type and how the iterable becomes an iterator. */
  readonly loops = new Map<Expr, { item: Type; from: Type }>();
}
