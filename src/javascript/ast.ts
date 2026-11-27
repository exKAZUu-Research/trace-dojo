/** The rows a construct spans, 0-based. */
export interface Span {
  row: number;
}

export interface Program {
  body: Statement[];
  scope: ScopeDeclarations;
  /** Whether the program's own code is strict mode code, outside which failed assignments do nothing. */
  isStrict: boolean;
  hasCommonJsReceiver?: boolean;
  /**
   * Whether turning a function into text is unavailable, as for TypeScript, whose functions Node.js shows as the
   * source a compiler printed rather than as written.
   */
  rejectsFunctionText?: boolean;
  /** Whether reading a library member the realm leaves out ends the program, as for TypeScript, which rejects it. */
  rejectsUnavailableMembers?: boolean;
  /** Generated helper bindings (such as namespace/enum receivers) omitted from learner variable snapshots. */
  hiddenNames?: ReadonlySet<string>;
}

/** The names a function body or block declares, which its scope creates before running its statements. */
export interface ScopeDeclarations {
  /** `let`, `const`, and `class` names, which stay uninitialized until their declaration runs. */
  lexical: {
    name: string;
    /** Names an immutable binding in the TypeError an assignment to it throws; undefined for a mutable one. */
    kind?: 'constant' | 'using' | 'await using';
  }[];
  /** Function declarations, which are initialized before anything runs. */
  functions: FunctionNode[];
  /** `var` names of a function body or the program, which start as `undefined`. */
  vars: string[];
  /** Every name above in the order of its first declaration, which traces list variables in. */
  order: string[];
  /** Whether a `using` declaration is directly in the scope, whose end then disposes of what it declared. */
  disposes: boolean;
}

export type Statement = Span &
  (
    | { kind: 'expression'; expression: Expression; stepRow?: number }
    | VariableDeclaration
    | { kind: 'function' }
    | { kind: 'class'; cls: ClassNode }
    /** A `return`, which awaits its value in an async generator. */
    | { kind: 'return'; value?: Expression; awaitsValue: boolean }
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
        /** Whether it is `for await`, which awaits each result of the iterator. */
        isAwait: boolean;
        declarationKind?: DeclarationKind;
        target: Pattern;
        iterable: Expression;
        /** How V8 names the iterable in the error a value without an iterator throws. */
        iterableSource?: IterationSource;
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

/** How a declaration declares its variables; a `using` one also disposes of their values when its scope ends. */
export type DeclarationKind = 'let' | 'const' | 'var' | 'using' | 'await using';

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
  /** Whether calling this function omits its call site from trace `callLines`, as for a synthesized namespace wrapper. */
  hidesCallRow?: boolean;
  /** The text `toString()` returns. */
  source: string;
  /** Whether the function is strict mode code, which a class or a `"use strict"` directive makes it. */
  isStrict: boolean;
}

export interface ClassNode extends Span {
  name: string;
  superClass?: Expression;
  ctor?: FunctionNode;
  afterSuper?: Statement[];
  members: ClassMember[];
  source: string;
  /** The class's decorators, in source order, as TypeScript's standard decorators apply them. */
  decorators?: Expression[];
}

export type ClassMember =
  | {
      kind: 'method' | 'getter' | 'setter';
      isStatic: boolean;
      key: PropertyName;
      fn: FunctionNode;
      decorators?: Expression[];
    }
  | {
      kind: 'field';
      isStatic: boolean;
      isTraceConstant?: true;
      key: PropertyName;
      value?: Expression;
      stepRow?: number;
      row: number;
      decorators?: Expression[];
      /** Whether it is `accessor x`, a getter and a setter of a value the instance keeps privately. */
      isAutoAccessor?: true;
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
  | { kind: 'spread'; argument: Expression }
  /** `__proto__: value`, which sets the prototype of the object to the value when it is an object or null. */
  | { kind: 'prototype'; value: Expression };

/** How V8's CallPrinter names an operand in the TypeError that iterating or destructuring it throws. */
export interface IterationSource {
  text: string;
  /** The callee of a call or `new` operand, which V8 names instead of the operand. */
  callee?: string;
  /** Whether the operand is an optional chain, which V8 prints as `(intermediate value)` or names by its value. */
  isOptionalChain?: boolean;
  /** The name a loop's error gives a value without an iterator in place of its type, as a `??` operand's callee. */
  unreadName?: string;
}

/**
 * Where an iteration's operand is written, which decides how V8 words the TypeError for a value without an iterator:
 * a spread that is the only and last argument of a call keeps the spread, while one before other arguments is
 * lowered to an array; a nested array pattern that is a property's value is read as `{(intermediate value)}`.
 */
export type IterationContext = 'syntax' | 'forOf' | 'finalCallSpread' | 'loweredCallSpread' | 'propertyPattern';

export type Argument = Expression | { kind: 'spread'; argument: Expression; source: IterationSource };

export type Expression = Span & {
  /**
   * Whether a `yield` or an `await` runs while evaluating this expression, which a generator or an async function then
   * evaluates step by step.
   */
  suspends?: boolean;
} & (
    | { kind: 'literal'; value: undefined | null | boolean | number | bigint | string }
    | { kind: 'template'; strings: string[]; expressions: Expression[] }
    /**
     * The strings of a tagged template, which its tag receives as a frozen array with a frozen `raw` array; a string
     * with an invalid escape is `undefined`. Each evaluation of one site returns the same array.
     */
    | { kind: 'templateObject'; cooked: (string | undefined)[]; raw: string[] }
    | { kind: 'regex'; pattern: string; flags: string }
    | { kind: 'identifier'; name: string }
    | { kind: 'importedModule'; specifier: string }
    | { kind: 'this' }
    | { kind: 'newTarget' }
    | { kind: 'array'; elements: (Argument | undefined)[] }
    | { kind: 'object'; members: ObjectMember[] }
    | { kind: 'functionExpression'; fn: FunctionNode }
    | { kind: 'classExpression'; cls: ClassNode }
    | MemberExpression
    | {
        kind: 'call';
        skipsAfterSuper?: boolean;
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
    /** A `yield`, which in an async generator awaits its value, or with `yield*`, delegates to an async iterator. */
    | { kind: 'yield'; argument?: Expression; delegate: boolean; isAsync: boolean }
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
  inferredName?: string;
}

/** How V8 names what a pattern takes apart, in the TypeError a value it cannot take apart throws. */
export interface DestructuringSource {
  /** The initializer or the hidden variable V8 takes apart, as V8 prints it; without one, V8 names the value. */
  source?: IterationSource;
  /** Whether V8 names the value by its type, as `object null`, as it does for a parameter. */
  namesType?: boolean;
  /** Whether V8 reports reading the first property instead, as it does for a pattern inside another. */
  isNested?: boolean;
  iterationContext?: IterationContext;
}

export type Pattern = Span &
  (
    | { kind: 'identifier'; name: string }
    | MemberExpression
    | ({ kind: 'arrayPattern'; elements: (Pattern | undefined)[]; rest?: Pattern } & DestructuringSource)
    | ({
        kind: 'objectPattern';
        properties: { key: PropertyName; value: Pattern }[];
        rest?: Pattern;
      } & DestructuringSource)
    | { kind: 'default'; target: Pattern; value: Expression; initializerSource?: IterationSource }
  );
