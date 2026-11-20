import type { Expr, Pattern, Span } from './ast';
import type { Known } from './constLint';
import type { AdtDef, ClosureType, ConstDef, FnDef, TraitDef, Type } from './types';

/** A variable of a function or closure: a `let` binding, a parameter, or a binding of a pattern. */
export interface LocalVar {
  name: string;
  mutable: boolean;
  type: Type;
  slot: number;
  span: Span;
  /** The function or closure that owns the variable. */
  owner: FnContext;
  isSelf?: boolean;
  /** How a binding binds the value it matches: by value, or through a shared or mutable reference. */
  mode: 'move' | 'ref' | 'refMut';
  /** Whether the program assigns the variable after its declaration, for the check of immutable variables. */
  id: number;
}

/** What a function's or closure's body compiles to: its slots and the variables the trace shows. */
export interface FnContext {
  name: string;
  locals: LocalVar[];
  slotCount: number;
  /** The variables of enclosing functions a closure uses, in the order of its captures. */
  captures: LocalVar[];
  parent: FnContext | undefined;
  isClosure: boolean;
  isAtomic: boolean;
  /** For a closure, whether it moves its captures (`move ||`). */
  isMove: boolean;
  /** For a closure, how it uses its captures, which decides the closure trait it implements. */
  closureKind: 'Fn' | 'FnMut' | 'FnOnce';
  /** For a closure, the captured variables it moves out, which it captures by value even without `move`. */
  movedCaptures?: LocalVar[];
  reborrowedCaptures?: Set<LocalVar>;
}

export type PathRes =
  | { kind: 'local'; local: LocalVar }
  /** A captured variable of an enclosing function, by its index among the closure's captures. */
  | { kind: 'capture'; local: LocalVar; index: number }
  | { kind: 'fn'; fn: FnDef; typeArgs: Type[] }
  | { kind: 'ctor'; def: AdtDef; variant: number; typeArgs: Type[] }
  | { kind: 'const'; def: ConstDef; type: Type; typeArgs: Type[] }
  /** A constant of a primitive type, such as `i32::MAX` or `f64::consts::PI`. */
  | { kind: 'builtinConst'; type: Type; name: string }
  /** `_` on the left of an assignment. */
  | { kind: 'discard' };

/** How a method call reaches its receiver: through derefs, then by reference or by value. */
export interface ReceiverAdjust {
  /** The derefs from the receiver expression's type, each of a reference (`ref`/`mutRef`) or of an owner. */
  derefs: ('ref' | 'mutRef' | 'own')[];
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
  derefs: ('ref' | 'mutRef' | 'own')[];
  index: number;
  /** `Range`'s fields live on a `RangeValue`. */
  range: boolean;
}

export type Coercion =
  /** References that reach the same value: `&String` → `&str`, `&Box<T>` → `&T`, `&&T` → `&T`. */
  | { kind: 'deref'; derefs: ('ref' | 'mutRef' | 'own')[]; fromMut: boolean }
  /** A value becomes a trait object of the type it has. */
  | { kind: 'dyn'; type: Type; mutable: boolean }
  /** A collection becomes an iterator, as `IntoIterator` makes it. */
  | { kind: 'intoIter'; from: Type };

export interface IndexRes {
  container: 'slice' | 'str' | 'map' | 'vecDeque';
  range: boolean;
  /** Whether a library type's `Index` impl indexes it (a `Vec`), whose panics report the `[`'s position. */
  overloaded: boolean;
  derefs: ('ref' | 'mutRef' | 'own')[];
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
  readonly methods = new Map<Expr, MethodRes>();
  readonly fields = new Map<Expr, FieldRes>();
  readonly coercions = new Map<Expr, Coercion>();
  readonly indexes = new Map<Expr, IndexRes>();
  readonly tries = new Map<Expr, TryRes>();
  readonly closures = new Map<Expr, ClosureInfo>();
  readonly bindings = new Map<Pattern, LocalVar>();
  /** For a call through a variable or a field that holds a closure, the closure trait it uses. */
  readonly callKinds = new Map<Expr, ClosureType['kind']>();
  /** `for` loops: the element type and how the iterable becomes an iterator. */
  readonly loops = new Map<Expr, { item: Type; from: Type }>();
  /** Trait objects whose methods a call dispatches on. */
  readonly dynCalls = new Map<Expr, TraitDef>();
}
