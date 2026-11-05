/** A source range: rows are 0-based, offsets index UTF-16 code units of the source. */
export interface Span {
  row: number;
  endRow: number;
  start: number;
  end: number;
}

export type PrimitiveTypeName = 'byte' | 'short' | 'int' | 'long' | 'char' | 'float' | 'double' | 'boolean';

export type TypeSyntax =
  | ({ kind: 'primitive'; name: PrimitiveTypeName } & Span)
  /**
   * `qualifier` holds the enclosing types written before the name, as in `Outer.Inner`; `args` holds the type
   * arguments, which are empty for the diamond `<>`.
   */
  | ({ kind: 'named'; name: string; qualifier: string[]; args?: TypeSyntax[] } & Span)
  | ({ kind: 'wildcard'; bound: TypeSyntax | undefined; isSuper: boolean } & Span)
  | ({ kind: 'array'; element: TypeSyntax } & Span)
  | ({ kind: 'var' } & Span);

export interface Modifiers {
  isStatic: boolean;
  isFinal: boolean;
  isAbstract: boolean;
  /** Marks an interface method with a body that implementing classes inherit. */
  isDefault: boolean;
  access: 'public' | 'protected' | 'private' | 'package';
}

export interface CompilationUnit {
  classes: ClassDeclaration[];
  imports: ImportDeclaration[];
}

/** `import a.b.C;`, `import a.b.*;`, `import static a.b.C.m;`, or `import static a.b.C.*;`. */
export interface ImportDeclaration extends Span {
  isStatic: boolean;
  /** The names before the final `*`, or the full name of what a single import names. */
  names: string[];
  isWildcard: boolean;
}

export interface TypeParameter extends Span {
  name: string;
  bounds: TypeSyntax[];
}

export interface ClassDeclaration extends Span {
  kind: 'class' | 'interface' | 'enum';
  name: string;
  typeParameters: TypeParameter[];
  modifiers: Modifiers;
  superclass?: TypeSyntax;
  /** The interfaces a class implements or an interface extends. */
  interfaces: TypeSyntax[];
  /** The constants of an enum, in declaration order. */
  enumConstants: EnumConstant[];
  /** Whether the class is a record, whose components the parser turns into fields, accessors, and a constructor. */
  isRecord?: boolean;
  members: MemberDeclaration[];
}

export interface EnumConstant extends Span {
  name: string;
  args: Expression[];
  /** The body of a constant that is an anonymous subclass of its enum, as one that overrides methods is. */
  body?: MemberDeclaration[];
}

export type MemberDeclaration =
  | FieldDeclaration
  | MethodDeclaration
  | ConstructorDeclaration
  | InitializerBlock
  | ClassDeclaration;

export interface FieldDeclaration extends Span {
  kind: 'field';
  /** Whether the field holds a record component. */
  isRecordComponent?: boolean;
  modifiers: Modifiers;
  type: TypeSyntax;
  declarators: VariableDeclarator[];
}

export interface Parameter extends Span {
  name: string;
  /** The type of the variable, which is an array for a variable arity parameter. */
  type: TypeSyntax;
  isFinal: boolean;
  /** Whether the parameter takes a variable number of arguments, as in `int... values`. */
  isVarargs: boolean;
}

export interface MethodDeclaration extends Span {
  kind: 'method';
  name: string;
  typeParameters: TypeParameter[];
  modifiers: Modifiers;
  returnType: TypeSyntax | undefined;
  parameters: Parameter[];
  throwsTypes: TypeSyntax[];
  body: Block | undefined;
}

export interface ConstructorDeclaration extends Span {
  kind: 'constructor';
  name: string;
  modifiers: Modifiers;
  parameters: Parameter[];
  throwsTypes: TypeSyntax[];
  explicitCall: ExplicitConstructorCall | undefined;
  body: Block;
  /** Whether this is a record's compact canonical constructor, which assigns the fields after its body. */
  isCompact?: boolean;
}

export interface InitializerBlock extends Span {
  kind: 'initializer';
  isStatic: boolean;
  body: Block;
}

export interface ExplicitConstructorCall extends Span {
  kind: 'explicitConstructorCall';
  target: 'this' | 'super';
  args: Expression[];
}

export interface VariableDeclarator extends Span {
  name: string;
  /** Extra `[]` written after the name, as in `int a[]`. */
  extraDimensions: number;
  initializer: Expression | ArrayInitializer | undefined;
}

export type Statement =
  | Block
  | LocalVariableDeclaration
  | ExpressionStatement
  | IfStatement
  | WhileStatement
  | DoStatement
  | ForStatement
  | ForEachStatement
  | SwitchStatement
  | BreakStatement
  | ContinueStatement
  | ReturnStatement
  | ThrowStatement
  | TryStatement
  | LabeledStatement
  | YieldStatement
  | LocalClassStatement
  | EmptyStatement;

export interface Block extends Span {
  kind: 'block';
  statements: Statement[];
}

export interface LocalVariableDeclaration extends Span {
  kind: 'local';
  isFinal: boolean;
  type: TypeSyntax;
  declarators: VariableDeclarator[];
}

export interface ExpressionStatement extends Span {
  kind: 'expression';
  expression: Expression;
  /** Whether the compiler wrote the statement, as a record's constructor assigns its fields, so it records no step. */
  isGenerated?: boolean;
}

export interface IfStatement extends Span {
  kind: 'if';
  condition: Expression;
  consequence: Statement;
  alternative: Statement | undefined;
}

export interface WhileStatement extends Span {
  kind: 'while';
  condition: Expression;
  body: Statement;
}

export interface DoStatement extends Span {
  kind: 'do';
  body: Statement;
  condition: Expression;
}

export interface ForStatement extends Span {
  kind: 'for';
  init: LocalVariableDeclaration | ExpressionStatement[];
  condition: Expression | undefined;
  update: ExpressionStatement[];
  body: Statement;
}

export interface ForEachStatement extends Span {
  kind: 'forEach';
  isFinal: boolean;
  type: TypeSyntax;
  name: string;
  /** The span of the loop variable, whose binding is the step of each iteration. */
  variable: Span;
  iterable: Expression;
  body: Statement;
}

export interface SwitchStatement extends Span {
  kind: 'switch';
  selector: Expression;
  /** Arrow-form rules never fall through to the next group. */
  isArrowForm: boolean;
  groups: SwitchGroup[];
}

export interface SwitchGroup extends Span {
  /** `undefined` stands for `default`. */
  labels: (Expression | undefined)[];
  statements: Statement[];
}

export interface BreakStatement extends Span {
  kind: 'break';
  label: string | undefined;
}

export interface ContinueStatement extends Span {
  kind: 'continue';
  label: string | undefined;
}

export interface ReturnStatement extends Span {
  kind: 'return';
  value: Expression | undefined;
}

export interface ThrowStatement extends Span {
  kind: 'throw';
  value: Expression;
}

export interface TryStatement extends Span {
  kind: 'try';
  body: Block;
  catches: CatchClause[];
  finallyBlock: Block | undefined;
}

export interface CatchClause extends Span {
  types: TypeSyntax[];
  name: string;
  isFinal: boolean;
  body: Block;
}

export interface LabeledStatement extends Span {
  kind: 'labeled';
  label: string;
  body: Statement;
}

/** A class, interface, or enum declared inside a method body. */
export interface LocalClassStatement extends Span {
  kind: 'localClass';
  declaration: ClassDeclaration;
}

/** Gives the value of the enclosing switch expression; an arrow rule's expression body is one too. */
export interface YieldStatement extends Span {
  kind: 'yield';
  value: Expression;
}

export interface EmptyStatement extends Span {
  kind: 'empty';
}

export type Expression =
  | Literal
  | NameExpression
  | FieldAccess
  | ArrayAccess
  | MethodCall
  | NewObject
  | NewArray
  | Assignment
  | Update
  | Binary
  | Unary
  | Conditional
  | Cast
  | InstanceOf
  | SwitchExpression
  | Lambda
  | MethodReference
  | TypeReference
  | ClassLiteral
  | ThisExpression;

export type LiteralValue =
  | { type: 'int'; value: number }
  | { type: 'long'; value: bigint }
  | { type: 'float'; value: number }
  | { type: 'double'; value: number }
  | { type: 'char'; value: number }
  | { type: 'boolean'; value: boolean }
  | { type: 'string'; value: string }
  | { type: 'null' };

export interface Literal extends Span {
  kind: 'literal';
  literal: LiteralValue;
}

export interface NameExpression extends Span {
  kind: 'name';
  name: string;
}

export interface FieldAccess extends Span {
  kind: 'fieldAccess';
  /** `super` names the superclass view of `this`. */
  object: Expression | 'super';
  name: string;
}

export interface ArrayAccess extends Span {
  kind: 'arrayAccess';
  array: Expression;
  index: Expression;
}

export interface MethodCall extends Span {
  kind: 'call';
  object: Expression | 'super' | undefined;
  name: string;
  args: Expression[];
}

export interface NewObject extends Span {
  kind: 'new';
  type: TypeSyntax;
  args: Expression[];
  /** The body of an anonymous class, which extends or implements `type`. */
  body?: MemberDeclaration[];
  /** The enclosing instance written before `.new`, as in `outer.new Inner()`. */
  outer?: Expression;
}

export interface NewArray extends Span {
  kind: 'newArray';
  elementType: TypeSyntax;
  dimensionLengths: Expression[];
  /** Dimensions written as `[]` after the given lengths. */
  extraDimensions: number;
  initializer: ArrayInitializer | undefined;
}

export interface ArrayInitializer extends Span {
  kind: 'arrayInitializer';
  elements: (Expression | ArrayInitializer)[];
}

export type AssignmentOperator = '=' | '+=' | '-=' | '*=' | '/=' | '%=' | '&=' | '|=' | '^=' | '<<=' | '>>=' | '>>>=';

export interface Assignment extends Span {
  kind: 'assign';
  operator: AssignmentOperator;
  target: Expression;
  value: Expression;
}

export interface Update extends Span {
  kind: 'update';
  operator: '++' | '--';
  isPrefix: boolean;
  target: Expression;
}

export type BinaryOperator =
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '<'
  | '>'
  | '<='
  | '>='
  | '=='
  | '!='
  | '&&'
  | '||'
  | '&'
  | '|'
  | '^'
  | '<<'
  | '>>'
  | '>>>';

export interface Binary extends Span {
  kind: 'binary';
  operator: BinaryOperator;
  left: Expression;
  right: Expression;
}

export interface Unary extends Span {
  kind: 'unary';
  operator: '!' | '-' | '+' | '~';
  operand: Expression;
}

export interface Conditional extends Span {
  kind: 'conditional';
  condition: Expression;
  consequence: Expression;
  alternative: Expression;
}

export interface Cast extends Span {
  kind: 'cast';
  type: TypeSyntax;
  value: Expression;
}

export interface InstanceOf extends Span {
  kind: 'instanceOf';
  value: Expression;
  type: TypeSyntax;
  /** The pattern variable, as in `o instanceof String s`, which holds the value where the test is known true. */
  binding: PatternBinding | undefined;
}

export interface PatternBinding extends Span {
  name: string;
  isFinal: boolean;
}

export interface Lambda extends Span {
  kind: 'lambda';
  parameters: LambdaParameter[];
  body: Expression | Block;
}

/** A lambda parameter, whose type the functional interface decides when it is not written. */
export interface LambdaParameter extends Span {
  name: string;
  type: TypeSyntax | undefined;
  isFinal: boolean;
}

/** `Type::method`, `expression::method`, or `Type::new`. */
export interface MethodReference extends Span {
  kind: 'methodRef';
  /** An expression, which may turn out to name a class, or a type that only a type syntax can write. */
  target: { expression: Expression } | { type: TypeSyntax };
  /** The method's name, or `new` for a constructor. */
  name: string;
}

/** `Type.class`, the `Class` object of a type. */
export interface ClassLiteral extends Span {
  kind: 'classLiteral';
  type: TypeSyntax;
}

/** A class named by a type, which the compiler writes for the method references it expands into lambdas. */
export interface TypeReference extends Span {
  kind: 'typeRef';
  type: TypeSyntax;
}

export interface SwitchExpression extends Span {
  kind: 'switchExpression';
  selector: Expression;
  isArrowForm: boolean;
  groups: SwitchGroup[];
}

export interface ThisExpression extends Span {
  kind: 'this';
  /** The enclosing class written before `.this`, as in `Outer.this`. */
  qualifier?: TypeSyntax;
}
