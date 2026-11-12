/** The rows a construct spans, 0-based. */
export interface Span {
  row: number;
}

export interface Program {
  body: Statement[];
  scope: ScopeDeclarations;
}

/** The names a function body or block declares, which its scope creates before running its statements. */
export interface ScopeDeclarations {
  /** `let`, `const`, and `class` names, which stay uninitialized until their declaration runs. */
  lexical: { name: string; isConst: boolean }[];
  /** Function declarations, which are initialized before anything runs. */
  functions: FunctionNode[];
  /** `var` names of a function body or the program, which start as `undefined`. */
  vars: string[];
  /** Every name above in the order of its first declaration, which traces list variables in. */
  order: string[];
}

export type Statement = Span &
  (
    | { kind: 'expression'; expression: Expression; stepRow?: number }
    | VariableDeclaration
    | { kind: 'function' }
    | { kind: 'class'; cls: ClassNode }
    | { kind: 'return'; value?: Expression }
    | { kind: 'if'; test: Expression; consequent: Statement; alternate?: Statement }
    | Block
    | {
        kind: 'for';
        init?: VariableDeclaration | Expression;
        test?: Expression;
        update?: Expression;
        body: Statement;
        /** Recorded after the init and after each update. */
        stepRow?: number;
        /** Names the init declares with `let` or `const`, copied into a new scope for every iteration. */
        perIterationNames: string[];
        scope: ScopeDeclarations;
      }
    | {
        kind: 'forOf' | 'forIn';
        declarationKind?: DeclarationKind;
        target: Pattern;
        iterable: Expression;
        body: Statement;
        /** Recorded after each binding of the target. */
        stepRow?: number;
        scope: ScopeDeclarations;
      }
    | { kind: 'while'; test: Expression; body: Statement }
    | { kind: 'doWhile'; test: Expression; body: Statement }
    | { kind: 'break' | 'continue'; label?: string }
    | { kind: 'labeled'; label: string; body: Statement }
    | { kind: 'switch'; discriminant: Expression; cases: SwitchCase[]; scope: ScopeDeclarations }
    | { kind: 'throw'; argument: Expression }
    | { kind: 'try'; block: Block; handler?: CatchClause; finalizer?: Block }
    | { kind: 'empty' }
  );

export type DeclarationKind = 'let' | 'const' | 'var';

export interface VariableDeclaration extends Span {
  kind: 'declaration';
  declarationKind: DeclarationKind;
  declarators: { target: Pattern; init?: Expression }[];
  stepRow?: number;
}

export interface Block extends Span {
  kind: 'block';
  body: Statement[];
  scope: ScopeDeclarations;
}

export interface SwitchCase {
  test?: Expression;
  body: Statement[];
}

export interface CatchClause {
  param?: Pattern;
  body: Block;
  /** The names the parameter declares. */
  scope: ScopeDeclarations;
}

export type FunctionKind = 'normal' | 'arrow' | 'method' | 'getter' | 'setter' | 'classConstructor';

export interface FunctionNode extends Span {
  name: string;
  kind: FunctionKind;
  params: Pattern[];
  rest?: Pattern;
  /** Whether a named function expression sees its own name, which is then a binding of its own. */
  bindsOwnName: boolean;
  /** Whether calling the function creates a generator, which runs the body as its `next()` asks. */
  isGenerator: boolean;
  /** Whether calling the function returns a promise, which the body settles, suspending at each `await`. */
  isAsync: boolean;
  /** Whether the body (or an arrow function in it) reads `arguments`, which the call then creates. */
  usesArguments: boolean;
  body: Statement[] | Expression;
  scope: ScopeDeclarations;
  /** Whether a trace shows a call to this function as part of its caller's step, marked by `// atomic`. */
  isAtomic: boolean;
  /** The text `toString()` returns. */
  source: string;
}

export interface ClassNode extends Span {
  name: string;
  superClass?: Expression;
  ctor?: FunctionNode;
  members: ClassMember[];
  source: string;
}

export type ClassMember =
  | { kind: 'method' | 'getter' | 'setter'; isStatic: boolean; key: PropertyName; fn: FunctionNode }
  | {
      kind: 'field';
      isStatic: boolean;
      key: PropertyName;
      value?: Expression;
      stepRow?: number;
      row: number;
    }
  | { kind: 'staticBlock'; body: Statement[]; scope: ScopeDeclarations; row: number };

/** A property name: a fixed key, a computed one, or a private one written as `#name`. */
export type PropertyName =
  | { kind: 'key'; key: string }
  | { kind: 'computed'; expression: Expression }
  | { kind: 'private'; name: string };

export type ObjectMember =
  | { kind: 'property'; key: PropertyName; value: Expression }
  | { kind: 'getter' | 'setter'; key: PropertyName; fn: FunctionNode }
  | { kind: 'spread'; argument: Expression };

export type Argument = Expression | { kind: 'spread'; argument: Expression };

export type Expression = Span & {
  /**
   * Whether a `yield` or an `await` runs while evaluating this expression, which a generator or an async function then
   * evaluates step by step.
   */
  suspends?: boolean;
} & (
    | { kind: 'literal'; value: undefined | null | boolean | number | string }
    | { kind: 'template'; strings: string[]; expressions: Expression[] }
    /**
     * The strings of a tagged template, which its tag receives as a frozen array with a frozen `raw` array; a string
     * with an invalid escape is `undefined`. Each evaluation of one site returns the same array.
     */
    | { kind: 'templateObject'; cooked: (string | undefined)[]; raw: string[] }
    | { kind: 'regex'; pattern: string; flags: string }
    | { kind: 'identifier'; name: string }
    | { kind: 'this' }
    | { kind: 'newTarget' }
    | { kind: 'array'; elements: (Argument | undefined)[] }
    | { kind: 'object'; members: ObjectMember[] }
    | { kind: 'functionExpression'; fn: FunctionNode }
    | { kind: 'classExpression'; cls: ClassNode }
    | MemberExpression
    | {
        kind: 'call';
        callee: Expression | SuperReference;
        args: Argument[];
        optional: boolean;
        calleeText: string;
      }
    | { kind: 'new'; callee: Expression; args: Argument[]; calleeText: string }
    | { kind: 'assign'; operator: string; target: Pattern; value: Expression }
    | { kind: 'update'; operator: '++' | '--'; prefix: boolean; target: Pattern }
    | { kind: 'unary'; operator: string; argument: Expression }
    | { kind: 'binary'; operator: string; left: Expression; right: Expression }
    /** `#name in object`, which tests whether the object has the private member. */
    | { kind: 'privateIn'; name: string; right: Expression }
    | { kind: 'logical'; operator: '&&' | '||' | '??'; left: Expression; right: Expression }
    | { kind: 'conditional'; test: Expression; consequent: Expression; alternate: Expression }
    | { kind: 'sequence'; expressions: Expression[] }
    /** Ends an optional chain, as parentheses do. */
    | { kind: 'parenthesized'; expression: Expression }
    | { kind: 'yield'; argument?: Expression; delegate: boolean }
    | { kind: 'await'; argument: Expression }
  );

export interface SuperReference extends Span {
  kind: 'super';
}

export interface MemberExpression extends Span {
  kind: 'member';
  object: Expression | SuperReference;
  property: PropertyName;
  optional: boolean;
}

export type Pattern = Span &
  (
    | { kind: 'identifier'; name: string }
    | MemberExpression
    | { kind: 'arrayPattern'; elements: (Pattern | undefined)[]; rest?: Pattern }
    | {
        kind: 'objectPattern';
        properties: { key: PropertyName; value: Pattern }[];
        rest?: Pattern;
      }
    | { kind: 'default'; target: Pattern; value: Expression }
  );
