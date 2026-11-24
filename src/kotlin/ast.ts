/** The syntax tree of a Kotlin file, as the converter builds it from tree-sitter's tree. Rows are 0-based. */

export interface KotlinFile {
  packageName: string | undefined;
  /** The annotations of the file itself, written as `@file:Name`. */
  annotations: Annotation[];
  imports: Import[];
  declarations: Declaration[];
  /**
   * The annotations written on what is not a declaration, such as an expression, a type, or a local variable, with the
   * target each applies to as `AnnotationTarget` names it.
   */
  looseAnnotations: { annotation: Annotation; target: string }[];
}

export interface Import {
  row: number;
  path: string[];
  isWildcard: boolean;
  alias: string | undefined;
}

export interface Annotation {
  row: number;
  /** The last part of the written name, as `Deprecated` of `kotlin.Deprecated`. */
  name: string;
  /** The written name when it is qualified, as `kotlin.Deprecated`. */
  qualifiedName?: string;
  /** The parts of the written name. */
  path: string[];
  /** What the annotation applies to when it says so, as `get` of `@get:JvmName("x")`. */
  useSiteTarget: string | undefined;
  /** The arguments, or `undefined` when the annotation has no parentheses. */
  args: Argument[] | undefined;
  /** The classes `@OptIn` names, which must be opt-in markers. */
  markers?: { row: number; path: string[] }[];
}

export const VISIBILITY_KEYWORDS = ['private', 'protected', 'internal', 'public'] as const;

export interface Modifiers {
  keywords: ReadonlySet<string>;
  annotations: Annotation[];
  /** The context parameters of `context(name: Type) fun f()`, where a name may be `_`. */
  contextParameters?: ParameterDecl[];
}

export type TypeRef = NamedTypeRef | FunctionTypeRef;

export interface NamedTypeRef {
  kind: 'named';
  row: number;
  /** The segments of a qualified name such as `Map.Entry<K, V>`, each with its own type arguments. */
  parts: { name: string; args: TypeProjectionRef[] }[];
  nullable: boolean;
  /** Whether the type is written `T & Any`, which excludes `null` from a type parameter. */
  definitelyNonNull?: boolean;
  annotations?: Annotation[];
}

export interface FunctionTypeRef {
  kind: 'function';
  row: number;
  receiver: TypeRef | undefined;
  params: TypeRef[];
  returnType: TypeRef;
  nullable: boolean;
  isSuspend: boolean;
  /** The types of `context(A) () -> Unit`, which a call passes from its context. */
  contextTypes: TypeRef[];
  annotations?: Annotation[];
}

/** A type argument: `*`, or a type with an optional use-site variance. */
export type TypeProjectionRef = { star: true } | { star: false; variance: 'in' | 'out' | undefined; type: TypeRef };

export interface TypeParameterDecl {
  row: number;
  name: string;
  bounds: TypeRef[];
  variance: 'in' | 'out' | undefined;
  isReified: boolean;
  onlyInputTypes: boolean;
  annotations: Annotation[];
}

export type Declaration = FunctionDecl | ClassDecl | PropertyDecl | DestructuringDecl | TypeAliasDecl;

export interface TypeAliasDecl {
  kind: 'typeAlias';
  row: number;
  name: string;
  modifiers: Modifiers;
  typeParameters: TypeParameterDecl[];
  type: TypeRef;
}

export interface ParameterDecl {
  row: number;
  name: string;
  type: TypeRef | undefined;
  defaultValue: Expression | undefined;
  modifiers: Modifiers;
}

export type FunctionBody = { kind: 'block'; block: Block } | { kind: 'expression'; expression: Expression };

export interface FunctionDecl {
  kind: 'function';
  row: number;
  /** Whether the function is declared in a function body. */
  isLocal: boolean;
  /** The row where the body starts, up to which an `// atomic` annotation marks the function. */
  headerEndRow: number;
  name: string;
  modifiers: Modifiers;
  typeParameters: TypeParameterDecl[];
  receiver: TypeRef | undefined;
  params: ParameterDecl[];
  returnType: TypeRef | undefined;
  body: FunctionBody | undefined;
}

export type ClassKind = 'class' | 'interface' | 'object' | 'companion' | 'enum';

export interface ClassParameterDecl extends ParameterDecl {
  /** Whether the parameter also declares a property. */
  binding: 'val' | 'var' | undefined;
}

export type SuperSpec =
  | { kind: 'constructorCall'; row: number; type: NamedTypeRef; args: Argument[] }
  | { kind: 'type'; row: number; type: NamedTypeRef }
  /** A function type, as `(Int) -> Int` of `class Twice : (Int) -> Int`, which is its `FunctionN` interface. */
  | { kind: 'functionType'; row: number; type: FunctionTypeRef }
  | { kind: 'delegated'; row: number; type: NamedTypeRef; delegate: Expression };

export interface EnumEntryDecl {
  row: number;
  name: string;
  modifiers: Modifiers;
  args: Argument[];
  members: MemberDecl[] | undefined;
}

export interface ClassDecl {
  kind: 'class';
  row: number;
  /** Whether the class is declared in a function body. */
  isLocal: boolean;
  headerEndRow: number;
  /** The row of the closing brace, after which an object's members no longer run. */
  endRow: number;
  classKind: ClassKind;
  name: string;
  /** Whether the declaration is a `fun interface`, which lambdas convert to. */
  isFunInterface: boolean;
  modifiers: Modifiers;
  typeParameters: TypeParameterDecl[];
  primaryConstructor: { row: number; params: ClassParameterDecl[]; modifiers: Modifiers } | undefined;
  supers: SuperSpec[];
  members: MemberDecl[];
  enumEntries: EnumEntryDecl[];
}

export interface InitBlock {
  kind: 'init';
  row: number;
  block: Block;
}

export interface SecondaryConstructorDecl {
  kind: 'constructor';
  row: number;
  headerEndRow: number;
  modifiers: Modifiers;
  params: ParameterDecl[];
  delegation: { kind: 'this' | 'super'; row: number; args: Argument[] } | undefined;
  body: Block | undefined;
}

export type MemberDecl = FunctionDecl | PropertyDecl | ClassDecl | InitBlock | SecondaryConstructorDecl | TypeAliasDecl;

export interface Accessor {
  row: number;
  modifiers: Modifiers;
  /** The name of a setter's parameter. */
  parameterName: string | undefined;
  type: TypeRef | undefined;
  body: FunctionBody | undefined;
}

export interface PropertyDecl {
  kind: 'property';
  row: number;
  modifiers: Modifiers;
  isVar: boolean;
  name: string;
  type: TypeRef | undefined;
  receiver: TypeRef | undefined;
  typeParameters: TypeParameterDecl[];
  initializer: Expression | undefined;
  delegate: Expression | undefined;
  getter: Accessor | undefined;
  setter: Accessor | undefined;
}

/** A variable of a destructuring declaration, or `undefined` for `_`. */
export type DestructuredName = { row: number; name: string; type: TypeRef | undefined } | undefined;

export interface DestructuringDecl {
  kind: 'destructuring';
  row: number;
  modifiers: Modifiers;
  isVar: boolean;
  names: DestructuredName[];
  initializer: Expression;
}

export interface Block {
  row: number;
  endRow: number;
  statements: Statement[];
  /** Whether the block was written with braces, rather than as a single statement of a control structure. */
  isBraced: boolean;
}

export type Statement =
  | Declaration
  | { kind: 'expressionStatement'; row: number; expression: Expression }
  | AssignmentStatement
  | ForStatement
  | WhileStatement
  | DoWhileStatement;

export type AssignmentOperator = '=' | '+=' | '-=' | '*=' | '/=' | '%=';

export interface AssignmentStatement {
  kind: 'assignment';
  row: number;
  operator: AssignmentOperator;
  target: Expression;
  value: Expression;
}

export interface ForStatement {
  kind: 'for';
  row: number;
  label: string | undefined;
  variable: { row: number; name: string; type: TypeRef | undefined } | { row: number; names: DestructuredName[] };
  iterable: Expression;
  body: Block;
}

export interface WhileStatement {
  kind: 'while';
  row: number;
  label: string | undefined;
  condition: Expression;
  body: Block;
}

export interface DoWhileStatement {
  kind: 'doWhile';
  row: number;
  label: string | undefined;
  /** The row of `while`, where the condition is evaluated. */
  conditionRow: number;
  condition: Expression;
  body: Block;
}

export interface Argument {
  row: number;
  name: string | undefined;
  value: Expression;
  isSpread: boolean;
}

export interface LambdaParameter {
  row: number;
  /** `undefined` for `_` and for a destructured parameter. */
  name: string | undefined;
  type: TypeRef | undefined;
  /** The variables of a destructured parameter, as `k` and `v` of `{ (k, v) -> ... }`. */
  destructured?: DestructuredName[];
}

export interface LambdaExpression {
  kind: 'lambda';
  row: number;
  endRow: number;
  /** The label that `return@label` and `this@label` name: written as `label@`, or else the function it is passed to. */
  label: string | undefined;
  /** `undefined` when the lambda declares no parameters, so that a single one is `it`. */
  params: LambdaParameter[] | undefined;
  statements: Statement[];
}

export type WhenCondition =
  | { kind: 'expression'; row: number; expression: Expression }
  | { kind: 'in'; row: number; negated: boolean; expression: Expression }
  | { kind: 'is'; row: number; negated: boolean; type: TypeRef };

export interface WhenEntry {
  row: number;
  /** Empty for `else`. */
  conditions: WhenCondition[];
  /** The condition after `if` that the entry also requires. */
  guard: Expression | undefined;
  body: Block;
}

export type BinaryOperator =
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '=='
  | '!='
  | '==='
  | '!=='
  | '<'
  | '<='
  | '>'
  | '>='
  | '&&'
  | '||'
  | '?:'
  | '..'
  | '..<';

export type Expression =
  | { kind: 'integer'; row: number; text: string; value: bigint; suffix: '' | 'L' | 'u' | 'uL' }
  | { kind: 'real'; row: number; text: string; value: number; isFloat: boolean }
  | { kind: 'char'; row: number; value: number }
  | { kind: 'string'; row: number; parts: (string | Expression)[] }
  | { kind: 'boolean'; row: number; value: boolean }
  | { kind: 'null'; row: number }
  | { kind: 'name'; row: number; name: string }
  | { kind: 'this'; row: number; label: string | undefined }
  | { kind: 'super'; row: number; type: NamedTypeRef | undefined; label: string | undefined }
  | { kind: 'member'; row: number; receiver: Expression; name: string; isSafe: boolean }
  | CallExpression
  | { kind: 'index'; row: number; receiver: Expression; indices: Expression[] }
  | { kind: 'prefix'; row: number; operator: '-' | '+' | '!' | '++' | '--'; operand: Expression }
  | { kind: 'postfix'; row: number; operator: '++' | '--' | '!!'; operand: Expression }
  | { kind: 'binary'; row: number; operator: BinaryOperator; left: Expression; right: Expression }
  | { kind: 'infix'; row: number; name: string; left: Expression; right: Expression }
  | { kind: 'in'; row: number; negated: boolean; left: Expression; right: Expression }
  | { kind: 'is'; row: number; negated: boolean; operand: Expression; type: TypeRef }
  | { kind: 'as'; row: number; isSafe: boolean; operand: Expression; type: TypeRef }
  /** Only a callee keeps its parentheses, as `(f)()` invokes the value `f` rather than calling a function `f`. */
  | { kind: 'parenthesized'; row: number; expression: Expression }
  | { kind: 'if'; row: number; condition: Expression; thenBranch: Block; elseBranch: Block | undefined }
  | {
      kind: 'when';
      row: number;
      subject: Expression | undefined;
      /** The variable of `when (val x = ...)`, which holds the subject. */
      subjectVariable: { row: number; name: string; type: TypeRef | undefined } | undefined;
      entries: WhenEntry[];
    }
  | {
      kind: 'try';
      row: number;
      body: Block;
      catches: { row: number; name: string; type: TypeRef; body: Block }[];
      finally: Block | undefined;
    }
  | LambdaExpression
  | AnonymousFunctionExpression
  | ObjectExpression
  | {
      kind: 'reference';
      row: number;
      /**
       * What is written before `::`: a type such as `List<Int>`, or an expression, which may name a class as `String` or
       * `A.B` does, or a value as `p` does; `undefined` for `::f`.
       */
      receiver: { kind: 'type'; type: NamedTypeRef } | { kind: 'expression'; expression: Expression } | undefined;
      /** The referenced member, or `class` for `X::class`. */
      name: string;
    }
  /** `[a, b]`, which only an annotation's argument may be. */
  | { kind: 'collectionLiteral'; row: number; elements: Expression[] }
  | { kind: 'throw'; row: number; value: Expression }
  | { kind: 'return'; row: number; label: string | undefined; value: Expression | undefined }
  | { kind: 'break'; row: number; label: string | undefined }
  | { kind: 'continue'; row: number; label: string | undefined };

/** `fun(x: Int): Int { ... }`, a function value whose `return` leaves the function itself. */
export interface AnonymousFunctionExpression {
  kind: 'anonymousFunction';
  row: number;
  endRow: number;
  decl: FunctionDecl;
}

/** `object : Base(args), I { ... }`, an instance of a class that the expression declares. */
export interface ObjectExpression {
  kind: 'object';
  row: number;
  decl: ClassDecl;
}

export interface CallExpression {
  kind: 'call';
  row: number;
  callee: Expression;
  typeArgs: TypeRef[];
  args: Argument[];
  /** A lambda written after the parentheses, which is the last argument. */
  trailingLambda: LambdaExpression | undefined;
}

export function isNullLiteral(expression: Expression): boolean {
  return expression.kind === 'null';
}
