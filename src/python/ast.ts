/** The 0-based row a construct starts on. */
export interface Span {
  row: number;
}

/** The row of every construct of standard library code written in Python, which is not part of the program. */
export const LIBRARY_ROW = -1;

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
  | { kind: 'str'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'none' }
  | { kind: 'ellipsis' };

export interface FormattedValue {
  expression: Expression;
  conversion?: 'r' | 's' | 'a';
  spec?: Expression;
  /** The source text of a self-documenting `{x=}`, which precedes the value. */
  debugText?: string;
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
}

export type Expression = Span &
  (
    | { kind: 'constant'; value: Constant }
    | NameRef
    | { kind: 'fstring'; parts: (string | FormattedValue)[] }
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
  );

export type BinaryOperator = '+' | '-' | '*' | '/' | '//' | '%' | '**' | '@' | '<<' | '>>' | '&' | '|' | '^';

export type CompareOperator = '<' | '<=' | '>' | '>=' | '==' | '!=' | 'in' | 'not in' | 'is' | 'is not';

/** What an assignment, a `for` loop, or a `with` item stores into. */
export type Target =
  | NameRef
  | (Span & { kind: 'attribute'; object: Expression; name: string })
  | (Span & { kind: 'subscript'; object: Expression; index: Expression })
  | (Span & { kind: 'unpack'; elements: Target[] });

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
}

export interface Parameter {
  name: string;
  kind: 'positionalOnly' | 'positional' | 'varArgs' | 'keywordOnly' | 'varKeywords';
  default?: Expression;
  annotation?: Expression;
  row: number;
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
  /** Whether this is an instance method defined in a class body, whose first parameter the trace shows like `this`. */
  isMethod: boolean;
  /** The class whose body defines this function, for `super()` and name mangling. */
  className?: string;
  /** Whether the body uses `super` or `__class__`, which then needs the class it is defined in. */
  usesClassCell: boolean;
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
  (
    | { kind: 'expression'; expression: Expression; stepRow?: number }
    | { kind: 'yield'; value?: Expression }
    | { kind: 'assign'; targets: Target[]; value: Expression; stepRow?: number }
    | { kind: 'augmentedAssign'; target: Target; operator: BinaryOperator; value: Expression; stepRow?: number }
    | { kind: 'annotatedAssign'; target: Target; annotation: Expression; value?: Expression; stepRow?: number }
    | { kind: 'delete'; targets: Target[]; stepRow?: number }
    | { kind: 'pass' }
    | { kind: 'break' | 'continue' }
    | { kind: 'return'; value?: Expression }
    | { kind: 'raise'; exception?: Expression; cause?: Expression }
    | { kind: 'global' | 'nonlocal' }
    | { kind: 'if'; test: Expression; body: Statement[]; orelse: Statement[] }
    | { kind: 'while'; test: Expression; body: Statement[]; orelse: Statement[] }
    | { kind: 'for'; target: Target; iterable: Expression; body: Statement[]; orelse: Statement[]; stepRow?: number }
    | {
        kind: 'try';
        body: Statement[];
        handlers: ExceptHandler[];
        isGroup: boolean;
        orelse: Statement[];
        finalbody: Statement[];
      }
    | { kind: 'with'; items: WithItem[]; body: Statement[]; stepRow?: number }
    | { kind: 'match'; subject: Expression; cases: MatchCase[] }
    | { kind: 'functionDef'; fn: FunctionDef; binding: NameRef }
    | { kind: 'classDef'; cls: ClassDef; binding: NameRef }
    | { kind: 'import'; names: ImportName[] }
    | { kind: 'importFrom'; module: string; names: { name: string; binding: NameRef }[] }
    | { kind: 'importStar'; module: string }
  );

export interface Module {
  body: Statement[];
  scope: ScopeInfo;
  doc?: string;
}
