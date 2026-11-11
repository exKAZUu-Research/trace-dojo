/** The 0-based row a construct starts on. */
export interface Span {
  row: number;
}

/** How a name is read and written, settled by the scopes of the program before it runs. */
export type NameAccess =
  /** A variable of the running function. */
  | 'local'
  /** A variable of the running function that a nested function captures, or one captured from an enclosing function. */
  | 'cell'
  /** A module variable, or a builtin when the module has none. */
  | 'global'
  /** A name in a class body or the module body: the namespace first, then the module and the builtins. */
  | 'name'
  /** A name in a class body that an enclosing function defines: the class namespace first, then the captured cell. */
  | 'classCell';

export interface NameRef extends Span {
  kind: 'name';
  name: string;
  access: NameAccess;
}

export type Constant =
  | { kind: 'int'; value: bigint }
  | { kind: 'float'; value: number }
  | { kind: 'imaginary'; value: number }
  /** A string, which `isUnicode` marks when it starts with a `u` prefix, as annotations stringified keep. */
  | { kind: 'str'; value: string; isUnicode?: boolean }
  | { kind: 'bytes'; value: Uint8Array }
  | { kind: 'bool'; value: boolean }
  | { kind: 'none' }
  | { kind: 'ellipsis' };

export interface FormattedValue {
  expression: Expression;
  conversion?: 'r' | 's' | 'a';
  spec?: Expression;
  /** The source text of a self-documenting `{x=}`, which precedes the value. */
  debugText?: string;
  /** The source text of the expression, which a t-string's Interpolation keeps. */
  expressionText?: string;
}

export type Argument =
  | { kind: 'positional'; value: Expression }
  | { kind: 'star'; value: Expression }
  | { kind: 'keyword'; name: string; value: Expression }
  | { kind: 'doubleStar'; value: Expression };

export type DictItem = { kind: 'pair'; key: Expression; value: Expression } | { kind: 'doubleStar'; value: Expression };

export type Element = Expression | { kind: 'starred'; value: Expression; row: number };

export interface Comprehension {
  target: Target;
  iterable: Expression;
  conditions: Expression[];
  /** Whether the clause is `async for`, which iterates with `__aiter__` and `__anext__`. */
  isAsync?: true;
}

/**
 * Marks an expression or a statement that may suspend the running generator or coroutine in the middle of it, because
 * it contains a `yield` or an `await`, or, in a program that may run threads, a call, which may wait for another thread.
 * Only those take the slower path that can suspend; the others evaluate synchronously.
 */
export interface Suspends {
  suspends?: true;
}

export type Expression = Span &
  Suspends &
  (
    | { kind: 'constant'; value: Constant }
    | NameRef
    /** An f-string, or a t-string (PEP 750) when `template` is set. */
    | { kind: 'fstring'; parts: (string | FormattedValue)[]; template?: boolean }
    | { kind: 'list' | 'tuple' | 'set'; elements: Element[] }
    | { kind: 'dict'; items: DictItem[] }
    | { kind: 'attribute'; object: Expression; name: string }
    | { kind: 'subscript'; object: Expression; index: Expression }
    | { kind: 'slice'; lower?: Expression; upper?: Expression; step?: Expression }
    | { kind: 'call'; callee: Expression; args: Argument[] }
    | { kind: 'binary'; operator: BinaryOperator; left: Expression; right: Expression }
    | { kind: 'unary'; operator: '-' | '+' | '~'; operand: Expression }
    | { kind: 'not'; operand: Expression }
    | { kind: 'boolean'; operator: 'and' | 'or'; left: Expression; right: Expression }
    | { kind: 'conditional'; test: Expression; body: Expression; orelse: Expression }
    | { kind: 'compare'; operands: Expression[]; operators: CompareOperator[] }
    | { kind: 'lambda'; fn: FunctionDef }
    | { kind: 'namedExpression'; target: NameRef; value: Expression }
    | {
        kind: 'comprehension';
        type: 'list' | 'set' | 'dict' | 'generator';
        element: Expression;
        /** The value of a dict comprehension, whose `element` is the key. */
        value?: Expression;
        generators: Comprehension[];
        scope: ScopeInfo;
      }
    | { kind: 'yield'; value?: Expression }
    | { kind: 'yieldFrom'; value: Expression }
    | { kind: 'await'; value: Expression }
  );

export type BinaryOperator = '+' | '-' | '*' | '/' | '//' | '%' | '**' | '@' | '<<' | '>>' | '&' | '|' | '^';

export type CompareOperator = '<' | '<=' | '>' | '>=' | '==' | '!=' | 'in' | 'not in' | 'is' | 'is not';

/** What an assignment, a `for` loop, or a `with` item stores into. */
export type Target =
  | NameRef
  | (Span & { kind: 'attribute'; object: Expression; name: string })
  | (Span & { kind: 'subscript'; object: Expression; index: Expression })
  | (Span & {
      kind: 'unpack';
      elements: Target[];
      /** The index of the starred element, which takes a list of the items the others leave. */
      starIndex?: number;
    });

/** The variables of a function, a class body, a comprehension, or the module, as the compiler settles them. */
export interface ScopeInfo {
  kind: 'module' | 'function' | 'class' | 'comprehension';
  /** Names assigned in this scope, in the order of their first binding, which the trace lists variables in. */
  locals: string[];
  /** Locals that a nested scope captures, which live in cells. */
  cells: string[];
  /** Names captured from enclosing functions. */
  frees: string[];
  isGenerator: boolean;
  /** The cells of the list, set, and dict comprehensions in a function, which CPython inlines into its code. */
  inlinedCells?: string[];
  /**
   * Whether the scope is an `async def` (a coroutine, or an async generator when it also yields) or a comprehension
   * that awaits, which then suspends the coroutine running it or, for a generator expression, is an async generator.
   */
  isAsync?: true;
}

export interface Parameter {
  name: string;
  kind: 'positionalOnly' | 'positional' | 'varArgs' | 'keywordOnly' | 'varKeywords';
  default?: Expression;
  annotation?: Expression;
  row: number;
}

/** A type parameter written in brackets, such as `T: int` in `def f[T: int]()`. */
export interface TypeParam extends Span {
  kind: 'TypeVar' | 'TypeVarTuple' | 'ParamSpec';
  /** The name as written, which the parameter's `__name__` gives. */
  name: string;
  binding: NameRef;
  bound?: Expression;
  constraints?: Expression[];
  default?: Expression;
}

/**
 * The type parameters of a definition, which a scope of their own binds between the enclosing scope and the
 * definition's. Their bounds and defaults, the annotations of a function, and the bases of a class belong to it.
 */
export interface TypeParams {
  scope: ScopeInfo;
  params: TypeParam[];
}

export interface FunctionDef extends Span {
  name: string;
  qualifiedName: string;
  params: Parameter[];
  body: Statement[] | Expression;
  scope: ScopeInfo;
  decorators: Expression[];
  returns?: Expression;
  doc?: string;
  isAtomic: boolean;
  /** Whether this is a method defined in a class body, whose first parameter the trace shows like `this`. */
  isMethod: boolean;
  /** The class whose body defines this function, for `super()` and name mangling. */
  className?: string;
  /** Whether the body uses `super` or `__class__`, which then needs the class it is defined in. */
  usesClassCell: boolean;
  typeParams?: TypeParams;
}

export interface ClassDef extends Span {
  name: string;
  /** The attributes the methods assign through their first parameter, sorted, as `__static_attributes__` lists them. */
  staticAttributes: string[];
  qualifiedName: string;
  bases: Argument[];
  body: Statement[];
  scope: ScopeInfo;
  decorators: Expression[];
  doc?: string;
  /** The type parameters, with the names their scope binds to the tuple of them and to `Generic[...]`, its last base. */
  typeParams?: TypeParams & { tuple: NameRef; genericBase: NameRef };
}

export interface ExceptHandler extends Span {
  types?: Expression;
  name?: NameRef;
  body: Statement[];
}

export interface WithItem {
  context: Expression;
  target?: Target;
}

export interface MatchCase extends Span {
  pattern: Pattern;
  guard?: Expression;
  body: Statement[];
}

export type Pattern = Span &
  (
    | { kind: 'value'; value: Expression }
    | { kind: 'singleton'; value: true | false | undefined }
    | { kind: 'capture'; name?: NameRef }
    | { kind: 'sequence'; patterns: Pattern[]; starIndex?: number }
    | { kind: 'star'; name?: NameRef }
    | { kind: 'mapping'; keys: Expression[]; patterns: Pattern[]; rest?: NameRef }
    | { kind: 'class'; cls: Expression; patterns: Pattern[]; keywords: string[]; keywordPatterns: Pattern[] }
    | { kind: 'or'; patterns: Pattern[] }
    | { kind: 'as'; pattern: Pattern; name: NameRef }
  );

export interface ImportName {
  /** The dotted module name, such as `collections`. */
  module: string;
  /** The name bound: the alias, or the first part of the dotted name. */
  binding: NameRef;
  /** Whether the binding is the whole module named, rather than its first package. */
  bindsModule: boolean;
}

export type Statement = Span &
  Suspends &
  /** `displays` marks a statement of code compiled in 'single' mode, which shows its value as `sys.displayhook` does. */
  (
    | { kind: 'expression'; expression: Expression; stepRow?: number; displays?: true }
    | { kind: 'assign'; targets: Target[]; value: Expression; stepRow?: number }
    | { kind: 'augmentedAssign'; target: Target; operator: BinaryOperator; value: Expression; stepRow?: number }
    | {
        kind: 'annotatedAssign';
        target: Target;
        annotation: Expression;
        value?: Expression;
        stepRow?: number;
        /** Whether the annotation is stored into `__annotations__`, as `from __future__ import annotations` does. */
        storesAnnotation?: boolean;
        /** The position among a module's annotations, which running it adds to `__conditional_annotations__`. */
        annotationIndex?: number;
      }
    /** Creates the `__annotations__` dict that annotated assignments store into under `from __future__ import annotations`. */
    | { kind: 'setupAnnotations' }
    /** Binds a module's `__annotate__` and `__conditional_annotations__`, which its annotations need. */
    | { kind: 'setupAnnotate' }
    | { kind: 'delete'; targets: Target[]; stepRow?: number }
    | { kind: 'pass' }
    | { kind: 'break' | 'continue' }
    | { kind: 'return'; value?: Expression }
    | { kind: 'raise'; exception?: Expression; cause?: Expression }
    | { kind: 'assert'; test: Expression; message?: Expression }
    | { kind: 'global' | 'nonlocal' }
    | { kind: 'if'; test: Expression; body: Statement[]; orelse: Statement[] }
    | { kind: 'while'; test: Expression; body: Statement[]; orelse: Statement[] }
    | {
        kind: 'for';
        target: Target;
        iterable: Expression;
        body: Statement[];
        orelse: Statement[];
        stepRow?: number;
        isAsync?: true;
      }
    | {
        kind: 'try';
        body: Statement[];
        handlers: ExceptHandler[];
        isGroup: boolean;
        orelse: Statement[];
        finalbody: Statement[];
      }
    | { kind: 'with'; items: WithItem[]; body: Statement[]; stepRow?: number; isAsync?: true }
    | { kind: 'match'; subject: Expression; cases: MatchCase[] }
    | { kind: 'functionDef'; fn: FunctionDef; binding: NameRef }
    | { kind: 'classDef'; cls: ClassDef; binding: NameRef }
    /** `type Name[T] = value`, whose value its type parameters' scope evaluates when first read. */
    | { kind: 'typeAlias'; name: string; binding: NameRef; typeParams: TypeParams; value: Expression }
    | { kind: 'import'; names: ImportName[] }
    | { kind: 'importFrom'; module: string; names: { name: string; binding: NameRef }[] }
    | { kind: 'importStar'; module: string }
  );

export interface Module {
  body: Statement[];
  scope: ScopeInfo;
  doc?: string;
  /** The `__future__` features the module enables, which the code it compiles inherits. */
  futureFeatures: string[];
  /** The source text the module was parsed from. */
  source?: string;
  /** The depth of the deepest node of its syntax tree, which tells how deeply its code may recurse when evaluated. */
  nestingDepth?: number;
}
