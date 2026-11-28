import type { IntName, SelfWrapper, Type } from './types';

/** A 0-based source row and the 1-based scalar column used by `dbg!`. Panic locations use the display column. */
export interface Span {
  row: number;
  col: number;
  displayCol?: number;
}

export interface Crate {
  items: Item[];
}

/** Where an item is visible; `in` lists the path of `pub(in path)`, a module around the item. */
export type Visibility = 'private' | 'pub' | 'super' | { in: string[] };

export type Item =
  | FnItem
  | StructItem
  | EnumItem
  | TraitItem
  | ImplItem
  | ConstItem
  | ModItem
  | UseItem
  | TypeAliasItem;

/** A type alias, which only the standard library's declarations use. */
export interface TypeAliasItem {
  kind: 'typeAlias';
  name: string;
  span: Span;
  vis: Visibility;
  generics: Generics;
  type: TypeAst;
}

export interface Attributes {
  derives: { name: string; span: Span }[];
  isDefault?: boolean;
  repr?: IntName;
  /** Whether a `#[repr(..)]` is written, of any kind (`C`, `transparent`, an integer). */
  hasRepr?: boolean;
}

export interface Generics {
  params: GenericParamAst[];
  lifetimes: string[];
  lifetimeBounds?: { name: string; outlives: string[] }[];
  where: WherePredicate[];
}

export interface GenericParamAst {
  name: string;
  span: Span;
  bounds: BoundAst[];
  defaultType?: TypeAst;
  constType?: TypeAst;
}

export interface WherePredicate {
  type: TypeAst;
  bounds: BoundAst[];
  span: Span;
}

export type BoundAst =
  | { kind: 'trait'; path: PathAst; span: Span }
  | { kind: 'static'; span: Span }
  | { kind: 'maybeSized'; span: Span }
  | { kind: 'lifetime'; name: string; span: Span }
  | { kind: 'fn'; trait: 'Fn' | 'FnMut' | 'FnOnce'; params: TypeAst[]; ret: TypeAst | undefined; span: Span };

export interface FnItem {
  kind: 'fn';
  isConst?: boolean;
  isUnsafe?: boolean;
  name: string;
  span: Span;
  vis: Visibility;
  generics: Generics;
  selfParam: SelfParam | undefined;
  params: Param[];
  ret: TypeAst | undefined;
  /** Undefined for a trait method without a default body. */
  body: Block | undefined;
  /** The row of the body's closing brace, where the function's locals go out of scope. */
  endRow: number;
  /** The row of the opening brace, through which a `// atomic` annotation marks the function. */
  headerEndRow: number;
  /** An `async fn`, whose `ret` and `body` are already those of the function returning the future. */
  isAsync?: boolean;
}

export interface SelfParam {
  mode: 'value' | 'ref' | 'mutRef';
  /** `self: Box<Self>` and the like, which take the receiver's pointer, and which a `Box<dyn Trait>` can call. */
  wrapper?: SelfWrapper;
  mutable: boolean;
  lifetime?: string;
  span: Span;
}

export interface Param {
  pattern: Pattern;
  type: TypeAst;
  span: Span;
}

export interface StructItem {
  kind: 'struct';
  name: string;
  span: Span;
  vis: Visibility;
  generics: Generics;
  shape: 'named' | 'tuple' | 'unit';
  fields: FieldAst[];
  attrs: Attributes;
  isUnion?: boolean;
}

export interface FieldAst {
  name: string;
  type: TypeAst;
  vis: Visibility;
  span: Span;
}

export interface EnumItem {
  kind: 'enum';
  name: string;
  span: Span;
  vis: Visibility;
  generics: Generics;
  variants: VariantAst[];
  attrs: Attributes;
}

export interface VariantAst {
  name: string;
  span: Span;
  shape: 'named' | 'tuple' | 'unit';
  fields: FieldAst[];
  discriminant: Expr | undefined;
  isDefault?: boolean;
}

export interface TraitItem {
  kind: 'trait';
  isUnsafe?: boolean;
  name: string;
  span: Span;
  vis: Visibility;
  generics: Generics;
  supertraits: BoundAst[];
  methods: FnItem[];
  assocTypes: { name: string; bounds: BoundAst[]; generics: Generics; span: Span }[];
  consts: ConstItem[];
}

export interface ImplItem {
  kind: 'impl';
  isUnsafe?: boolean;
  span: Span;
  generics: Generics;
  trait: PathAst | undefined;
  selfType: TypeAst;
  methods: FnItem[];
  consts: ConstItem[];
  assocTypes: { name: string; type: TypeAst; generics: Generics; span: Span }[];
}

export interface ConstItem {
  kind: 'const';
  name: string;
  span: Span;
  vis: Visibility;
  type: TypeAst;
  /** Undefined for a constant of the standard library whose value is native. */
  value: Expr | undefined;
  isStatic?: boolean;
  isMutable?: boolean;
}

export interface ModItem {
  kind: 'mod';
  name: string;
  span: Span;
  vis: Visibility;
  items: Item[];
}

export interface UseItem {
  kind: 'use';
  span: Span;
  vis: Visibility;
  entries: { path: string[]; alias: string | undefined; glob: boolean; span: Span }[];
}

export type TypeAst =
  | { kind: 'path'; path: PathAst; span: Span }
  | { kind: 'ref'; mutable: boolean; target: TypeAst; lifetime?: string; span: Span }
  | { kind: 'tuple'; elems: TypeAst[]; span: Span }
  | { kind: 'array'; elem: TypeAst; len: Expr; span: Span }
  | { kind: 'slice'; elem: TypeAst; span: Span }
  | { kind: 'infer'; span: Span }
  | { kind: 'never'; span: Span }
  | { kind: 'dyn'; bounds: BoundAst[]; lifetime?: string; span: Span }
  | { kind: 'impl'; bounds: BoundAst[]; span: Span }
  | { kind: 'fnBound'; bound: BoundAst & { kind: 'fn' }; span: Span }
  /** `type`: the type of the const parameter the value is given to, set once that parameter is known. */
  | { kind: 'constArg'; value: Expr; span: Span; type?: TypeAst }
  | { kind: 'pointer'; mutable: boolean; target: TypeAst; span: Span }
  | {
      kind: 'fnPointer';
      params: TypeAst[];
      ret: TypeAst | undefined;
      isUnsafe?: boolean;
      bound?: string[];
      span: Span;
    };

export interface PathAst {
  segments: PathSegment[];
  span: Span;
}

export interface PathSegment {
  name: string;
  /** Set on a path a macro's expansion makes to a helper of the standard library that programs cannot name. */
  internal?: true;
  /** For the first segment of `<T as Trait>::name` or `<T>::name`: the type and the trait it is qualified by. */
  qualified?: { self: TypeAst; trait: PathAst | undefined };
  args: TypeAst[] | undefined;
  lifetimes?: string[];
  bindings?: { name: string; type: TypeAst; span: Span }[];
  span: Span;
}

export interface Block {
  kind: 'block';
  stmts: Stmt[];
  tail: Expr | undefined;
  span: Span;
  endRow: number;
  items: Item[];
  ty?: Type;
  isConst?: boolean;
  isUnsafe?: boolean;
}

export type Stmt =
  | {
      kind: 'let';
      pattern: Pattern;
      type: TypeAst | undefined;
      init: Expr | undefined;
      else: Block | undefined;
      span: Span;
      /** A statement the conversion adds, which records no step of the trace. */
      hidden?: boolean;
    }
  | { kind: 'expr'; expr: Expr; semi: boolean; span: Span; hidden?: boolean }
  | { kind: 'empty'; span: Span };

interface ExprBase {
  span: Span;
  /** Filled by the type checker. */
  ty?: Type;
}

export type BinaryOp =
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '&'
  | '|'
  | '^'
  | '<<'
  | '>>'
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | '&&'
  | '||';

export type ArithOp = '+' | '-' | '*' | '/' | '%' | '&' | '|' | '^' | '<<' | '>>';

export type Expr = ExprBase &
  (
    | { kind: 'int'; value: bigint; suffix: string | undefined }
    | { kind: 'float'; value: number; f32: number; suffix: string | undefined }
    | { kind: 'bool'; value: boolean }
    | { kind: 'char'; value: string }
    | { kind: 'str'; value: string }
    | { kind: 'path'; path: PathAst }
    | { kind: 'unary'; op: '-' | '!' | '*'; operand: Expr }
    | { kind: 'binary'; op: BinaryOp; left: Expr; right: Expr; opSpan: Span }
    | { kind: 'assign'; target: Expr; value: Expr }
    | { kind: 'compoundAssign'; op: ArithOp; target: Expr; value: Expr }
    | { kind: 'ref'; mutable: boolean; operand: Expr; raw?: boolean }
    | { kind: 'cast'; operand: Expr; type: TypeAst }
    | { kind: 'call'; callee: Expr; args: Expr[] }
    | {
        kind: 'methodCall';
        receiver: Expr;
        method: string;
        turbofish: TypeAst[] | undefined;
        args: Expr[];
        methodSpan: Span;
      }
    | { kind: 'field'; operand: Expr; name: string; nameSpan: Span }
    | { kind: 'index'; operand: Expr; index: Expr; bracketSpan: Span }
    | { kind: 'range'; start: Expr | undefined; end: Expr | undefined; inclusive: boolean }
    | { kind: 'tuple'; elems: Expr[] }
    | { kind: 'array'; elems: Expr[] }
    | { kind: 'arrayRepeat'; value: Expr; count: Expr }
    | {
        kind: 'struct';
        path: PathAst;
        fields: { name: string; value: Expr; span: Span }[];
        base: Expr | undefined;
      }
    | Block
    | { kind: 'if'; cond: Condition; consequent: Block; else: Expr | undefined }
    | { kind: 'match'; scrutinee: Expr; arms: MatchArm[]; endRow: number }
    /** `isBlock`: a labeled block (`'a: { ... }`) that runs as a loop its end breaks out of, which no unlabeled `break` or `continue` targets. */
    | { kind: 'loop'; label: string | undefined; body: Block; isBlock?: boolean }
    | { kind: 'while'; label: string | undefined; cond: Condition; body: Block }
    | { kind: 'for'; label: string | undefined; pattern: Pattern; iterable: Expr; body: Block }
    | { kind: 'break'; label: string | undefined; value: Expr | undefined }
    | { kind: 'continue'; label: string | undefined }
    | { kind: 'return'; value: Expr | undefined }
    | {
        kind: 'closure';
        isMove: boolean;
        params: { pattern: Pattern; type: TypeAst | undefined; span: Span }[];
        ret: TypeAst | undefined;
        body: Expr;
        /** An `async` block (of an `async fn`), which the checker types as the future of running the closure's body. */
        isAsync?: 'block' | 'fn';
      }
    | { kind: 'try'; operand: Expr }
    | { kind: 'macro'; macro: MacroCall }
  );

export type Condition = { kind: 'expr'; expr: Expr } | { kind: 'let'; pattern: Pattern; value: Expr; span: Span };

export interface MatchArm {
  pattern: Pattern;
  /**
   * The arm's `if` guard, which runs after the pattern matches and lets later arms try when it is false: conditions
   * that must all hold, in order, whose `let` patterns bind variables for the arm's body (`if let Some(x) = f(v)`).
   */
  guard: Condition[] | undefined;
  body: Expr;
  span: Span;
}

export interface FormatArgs {
  pieces: FormatPiece[];
  args: Expr[];
  span: Span;
}

export type FormatPiece = string | FormatSpec;

export interface FormatSpec {
  arg: number;
  trait: 'display' | 'debug' | 'lowerHex' | 'upperHex' | 'octal' | 'binary' | 'lowerExp' | 'upperExp';
  fill: string;
  align: '<' | '>' | '^' | undefined;
  sign: '+' | '-' | undefined;
  alternate: boolean;
  zero: boolean;
  width: { kind: 'literal'; value: number } | { kind: 'arg'; arg: number } | undefined;
  precision: { kind: 'literal'; value: number } | { kind: 'arg'; arg: number } | undefined;
  debugHex?: 'x' | 'X';
}

export type MacroCall =
  | { kind: 'print'; stream: 'stdout' | 'stderr'; newline: boolean; format: FormatArgs | undefined }
  | { kind: 'format'; format: FormatArgs }
  | { kind: 'write'; target: Expr; newline: boolean; format: FormatArgs | undefined }
  | { kind: 'panic'; name: string; format: FormatArgs | undefined }
  /** `assert!`, with its condition's source text as `stringify!` gives it, which its default message quotes. */
  | { kind: 'assert'; cond: Expr; text: string; format: FormatArgs | undefined }
  | { kind: 'assertEq'; equal: boolean; left: Expr; right: Expr; format: FormatArgs | undefined }
  | { kind: 'vec'; elems: Expr[] }
  | { kind: 'vecRepeat'; value: Expr; count: Expr }
  | { kind: 'matches'; value: Expr; pattern: Pattern }
  /** `dbg!`'s arguments, with their source text as `stringify!` gives it (whitespace runs as single spaces). */
  | { kind: 'dbg'; args: Expr[]; texts: string[] };

interface PatternBase {
  span: Span;
  ty?: Type;
}

export type Pattern = PatternBase &
  (
    | { kind: 'wild' }
    | {
        kind: 'binding';
        name: string;
        mutable: boolean;
        byRef?: 'ref' | 'refMut';
        /** Set by the type checker: a default binding mode borrows what it binds (`Some(x)` matching `&mut o`). */
        inheritedRef?: 'ref' | 'refMut';
        sub: Pattern | undefined;
      }
    | { kind: 'lit'; expr: Expr }
    | { kind: 'tuple'; elems: Pattern[] }
    | { kind: 'tupleStruct'; path: PathAst; elems: Pattern[] }
    | {
        kind: 'struct';
        path: PathAst;
        fields: { name: string; pattern: Pattern; span: Span }[];
        rest: boolean;
      }
    /** `..` among the elements of a tuple, tuple struct, or slice pattern, which the checker expands for tuples. */
    | { kind: 'rest' }
    | { kind: 'range'; start: Pattern | undefined; end: Pattern | undefined; inclusive: boolean }
    /** `[a, b, rest @ .., z]`; `restIndex` is the position of its `..`, which the checker finds. */
    | { kind: 'slice'; elems: Pattern[]; restIndex?: number }
    | { kind: 'path'; path: PathAst }
    | { kind: 'ref'; mutable: boolean; pattern: Pattern }
    | { kind: 'or'; alternatives: Pattern[] }
  );
