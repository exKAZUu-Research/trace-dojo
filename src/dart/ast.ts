/** A source position: the 0-based row and column where a construct starts, and the offsets it spans. */
export interface Span {
  row: number;
  column: number;
  start: number;
  end: number;
}

export interface Library extends Span {
  imports: ImportDirective[];
  declarations: TopLevelDeclaration[];
}

/** `import 'dart:math' as m show max;`. */
export interface ImportDirective extends Span {
  uri: string;
  prefix: string | undefined;
  show: string[] | undefined;
  hide: string[];
}

export type TopLevelDeclaration =
  | ClassDeclaration
  | FunctionDeclaration
  | VariableDeclaration
  | TypeAliasDeclaration
  | ExtensionDeclaration;

export interface Annotation extends Span {
  names: string[];
  typeArguments: TypeSyntax[];
  arguments: Arguments | undefined;
}

export type ClassKind = 'class' | 'mixin' | 'enum' | 'extensionType' | 'mixinClass';

export interface ClassModifiers {
  isAbstract: boolean;
  isSealed: boolean;
  isBase: boolean;
  isFinal: boolean;
  isInterface: boolean;
}

export interface ClassDeclaration extends Span {
  kind: 'class';
  classKind: ClassKind;
  name: string;
  typeParameters: TypeParameter[];
  modifiers: ClassModifiers;
  superclass: TypeSyntax | undefined;
  mixins: TypeSyntax[];
  interfaces: TypeSyntax[];
  /** The types a mixin requires of the classes it is applied to (`mixin M on A`). */
  onTypes: TypeSyntax[];
  members: MemberDeclaration[];
  enumConstants: EnumConstant[];
  /** `class Point(final int x, final int y);` or the representation of an extension type. */
  primaryConstructor: PrimaryConstructor | undefined;
  annotations: Annotation[];
  /** Whether the declaration comes from the library sources the interpreter defines rather than the program. */
  isLibrary: boolean;
}

export interface PrimaryConstructor extends Span {
  name: string | undefined;
  isConst: boolean;
  parameters: FormalParameters;
}

export interface EnumConstant extends Span {
  annotations: Annotation[];
  name: string;
  typeArguments: TypeSyntax[] | undefined;
  constructorName: string | undefined;
  arguments: Arguments | undefined;
}

export interface ExtensionDeclaration extends Span {
  kind: 'extension';
  name: string | undefined;
  typeParameters: TypeParameter[];
  onType: TypeSyntax;
  members: MemberDeclaration[];
  annotations: Annotation[];
}

export interface TypeAliasDeclaration extends Span {
  kind: 'typeAlias';
  name: string;
  typeParameters: TypeParameter[];
  aliased: TypeSyntax;
  annotations: Annotation[];
}

export interface TypeParameter extends Span {
  annotations?: Annotation[];
  name: string;
  bound: TypeSyntax | undefined;
}

export type MemberDeclaration = FieldDeclaration | MethodDeclaration | ConstructorDeclaration;

export interface FieldDeclaration extends Span {
  kind: 'field';
  isStatic: boolean;
  isFinal: boolean;
  isConst: boolean;
  isLate: boolean;
  isCovariant: boolean;
  isExternal: boolean;
  isAbstract: boolean;
  type: TypeSyntax | undefined;
  variables: VariableDeclarator[];
  annotations: Annotation[];
}

export type MethodKind = 'method' | 'getter' | 'setter' | 'operator';

export interface MethodDeclaration extends Span {
  kind: 'method';
  methodKind: MethodKind;
  name: string;
  isStatic: boolean;
  isExternal: boolean;
  typeParameters: TypeParameter[];
  returnType: TypeSyntax | undefined;
  parameters: FormalParameters;
  /** Undefined for an abstract or external member. */
  body: FunctionBody | undefined;
  annotations: Annotation[];
  /** The row of the line that opens the body, which an `// atomic` annotation may end. */
  headerEndRow: number;
}

export type ConstructorKind = 'generative' | 'factory' | 'redirectingFactory';

export interface ConstructorDeclaration extends Span {
  kind: 'constructor';
  constructorKind: ConstructorKind;
  /** The class name the constructor is written with, which must be its class's. */
  className: string | undefined;
  /** The name after the class name (`A.named`), or undefined for the unnamed constructor. */
  name: string | undefined;
  isConst: boolean;
  isExternal: boolean;
  parameters: FormalParameters;
  initializers: ConstructorInitializer[];
  body: FunctionBody | undefined;
  /** A redirecting factory's target (`factory A() = B;`). */
  redirectTarget: { type: TypeSyntax; name: string | undefined } | undefined;
  annotations: Annotation[];
  headerEndRow: number;
}

export type ConstructorInitializer =
  | ({ kind: 'field'; name: string; value: Expression } & Span)
  | ({ kind: 'super'; name: string | undefined; arguments: Arguments } & Span)
  | ({ kind: 'this'; name: string | undefined; arguments: Arguments } & Span)
  | ({ kind: 'assert'; condition: Expression; message: Expression | undefined } & Span);

export interface FunctionDeclaration extends Span {
  kind: 'function';
  name: string;
  /** Top-level getters and setters. */
  functionKind: 'function' | 'getter' | 'setter';
  isExternal: boolean;
  typeParameters: TypeParameter[];
  returnType: TypeSyntax | undefined;
  parameters: FormalParameters;
  body: FunctionBody | undefined;
  annotations: Annotation[];
  headerEndRow: number;
}

export interface VariableDeclaration extends Span {
  kind: 'variables';
  isFinal: boolean;
  isConst: boolean;
  isLate: boolean;
  /** Undefined for `var`, `final`, or `const` without a type. */
  type: TypeSyntax | undefined;
  variables: VariableDeclarator[];
  annotations: Annotation[];
}

export interface VariableDeclarator extends Span {
  name: string;
  initializer: Expression | undefined;
}

export interface FormalParameters extends Span {
  positional: FormalParameter[];
  /** How many positional parameters are required; the rest sit in `[...]`. */
  requiredCount: number;
  named: FormalParameter[];
}

export interface FormalParameter extends Span {
  annotations?: Annotation[];
  name: string;
  type: TypeSyntax | undefined;
  /** `this.x` initializes a field, `super.x` passes the argument on to the superclass constructor. */
  binding: 'plain' | 'this' | 'super';
  isVar?: boolean;
  isFinal: boolean;
  isCovariant: boolean;
  isRequired: boolean;
  defaultValue: Expression | undefined;
  /** An old-style function-typed parameter `int f(int x)`. */
  functionType: { returnType: TypeSyntax | undefined; parameters: FormalParameters } | undefined;
}

export type FunctionBody =
  | ({ kind: 'block'; block: Block; modifier: BodyModifier } & Span)
  | ({ kind: 'expression'; expression: Expression; modifier: BodyModifier } & Span);

export type BodyModifier = 'sync' | 'sync*' | 'async' | 'async*';

export type TypeSyntax =
  | ({
      kind: 'named';
      /** The library prefix of an imported type, as `m` in `m.Random`. */
      prefix: string | undefined;
      name: string;
      args: TypeSyntax[];
      nullable: boolean;
    } & Span)
  | ({
      kind: 'function';
      returnType: TypeSyntax | undefined;
      typeParameters: TypeParameter[];
      parameters: ParameterTypes;
      nullable: boolean;
    } & Span)
  | ({
      kind: 'record';
      positional: TypeSyntax[];
      named: { name: string; type: TypeSyntax }[];
      nullable: boolean;
    } & Span)
  | ({ kind: 'void' } & Span);

export interface ParameterTypes {
  positional: { name: string | undefined; type: TypeSyntax }[];
  requiredCount: number;
  named: { name: string; type: TypeSyntax; isRequired: boolean }[];
}

export interface Block extends Span {
  kind: 'block';
  statements: Statement[];
}

export type Statement =
  | Block
  | ({ kind: 'expression'; expression: Expression } & Span)
  | ({ kind: 'local'; declaration: VariableDeclaration } & Span)
  | ({ kind: 'patternDeclaration'; isFinal: boolean; pattern: Pattern; value: Expression } & Span)
  | ({ kind: 'localFunction'; declaration: FunctionDeclaration } & Span)
  | ({
      kind: 'if';
      condition: Expression;
      /** `if (x case pattern when guard)`. */
      casePattern: { pattern: Pattern; guard: Expression | undefined } | undefined;
      consequence: Statement;
      alternative: Statement | undefined;
    } & Span)
  | ({ kind: 'while'; condition: Expression; body: Statement } & Span)
  | ({ kind: 'do'; condition: Expression; body: Statement } & Span)
  | ({
      kind: 'for';
      init: VariableDeclaration | Expression[] | undefined;
      condition: Expression | undefined;
      updates: Expression[];
      body: Statement;
    } & Span)
  | ({ kind: 'forIn'; binding: ForInBinding; iterable: Expression; body: Statement; isAwait: boolean } & Span)
  | ({ kind: 'switch'; subject: Expression; cases: SwitchCase[] } & Span)
  | ({ kind: 'break'; label: string | undefined } & Span)
  | ({ kind: 'continue'; label: string | undefined } & Span)
  | ({ kind: 'return'; value: Expression | undefined } & Span)
  | ({ kind: 'try'; body: Block; catches: CatchClause[]; finally: Block | undefined } & Span)
  | ({ kind: 'rethrow' } & Span)
  | ({ kind: 'labeled'; labels: string[]; body: Statement } & Span)
  | ({ kind: 'assert'; condition: Expression; message: Expression | undefined } & Span)
  | ({ kind: 'yield'; value: Expression; isEach: boolean } & Span);

export type ForInBinding =
  /** `for (var x in …)`, `for (final int x in …)`, or `for (x in …)` with an existing variable. */
  | ({
      kind: 'declaration';
      isFinal: boolean;
      type: TypeSyntax | undefined;
      name: string;
      annotations?: Annotation[];
    } & Span)
  | ({ kind: 'identifier'; name: string } & Span)
  | ({ kind: 'pattern'; isFinal: boolean; pattern: Pattern; annotations?: Annotation[] } & Span);

export interface SwitchCase extends Span {
  /** Undefined for `default:`. */
  pattern: Pattern | undefined;
  guard: Expression | undefined;
  labels: string[];
  statements: Statement[];
}

export interface CatchClause extends Span {
  /** The type after `on`, undefined to catch everything. */
  type: TypeSyntax | undefined;
  exception: string | undefined;
  stackTrace: string | undefined;
  body: Block;
}

export type Pattern =
  | ({ kind: 'constant'; value: Expression } & Span)
  /** `var x`, `final int x`, `int x`, `x` in a declaration, or `_`. */
  | ({ kind: 'variable'; name: string; type: TypeSyntax | undefined; isFinal: boolean; keyword: boolean } & Span)
  | ({ kind: 'wildcard'; type: TypeSyntax | undefined } & Span)
  | ({ kind: 'or'; left: Pattern; right: Pattern } & Span)
  | ({ kind: 'and'; left: Pattern; right: Pattern } & Span)
  | ({ kind: 'relational'; operator: string; value: Expression } & Span)
  | ({ kind: 'cast'; pattern: Pattern; type: TypeSyntax } & Span)
  | ({ kind: 'nullCheck'; pattern: Pattern } & Span)
  | ({ kind: 'nullAssert'; pattern: Pattern } & Span)
  | ({ kind: 'list'; typeArguments: TypeSyntax[] | undefined; elements: ListPatternElement[] } & Span)
  | ({ kind: 'map'; typeArguments: TypeSyntax[] | undefined; entries: { key: Expression; value: Pattern }[] } & Span)
  | ({ kind: 'record'; fields: RecordPatternField[] } & Span)
  | ({ kind: 'object'; type: TypeSyntax; fields: RecordPatternField[] } & Span)
  | ({ kind: 'parenthesized'; pattern: Pattern } & Span)
  /** A bare identifier in an assignment pattern, which assigns an existing variable. */
  | ({ kind: 'assignedVariable'; name: string } & Span);

export type ListPatternElement = Pattern | ({ kind: 'rest'; pattern: Pattern | undefined } & Span);

/** `name: pattern`, `:name` (the field named like the variable), or a positional field. */
export interface RecordPatternField extends Span {
  name: string | undefined;
  pattern: Pattern;
}

export interface Arguments extends Span {
  positional: Expression[];
  named: NamedArgument[];
  /** Every argument in source order, which is the order Dart evaluates them in. */
  order: ({ kind: 'positional'; index: number } | { kind: 'named'; index: number })[];
}

export interface NamedArgument extends Span {
  name: string;
  value: Expression;
}

export type CollectionElement =
  | Expression
  | ({ kind: 'spread'; value: Expression; nullAware: boolean } & Span)
  | ({ kind: 'nullAwareElement'; value: Expression } & Span)
  | ({
      kind: 'ifElement';
      condition: Expression;
      casePattern: { pattern: Pattern; guard: Expression | undefined } | undefined;
      consequent: CollectionElement;
      alternative: CollectionElement | undefined;
    } & Span)
  | ({
      kind: 'forElement';
      init: VariableDeclaration | Expression[] | undefined;
      condition: Expression | undefined;
      updates: Expression[];
      body: CollectionElement;
    } & Span)
  | ({ kind: 'forInElement'; binding: ForInBinding; iterable: Expression; body: CollectionElement } & Span)
  | ({ kind: 'mapEntry'; key: Expression; value: Expression; nullAwareKey: boolean; nullAwareValue: boolean } & Span);

export type StringPart = string | Expression;

export interface RecordLiteralField extends Span {
  name: string | undefined;
  value: Expression;
}

export type Expression =
  | ({ kind: 'int'; value: bigint; text: string } & Span)
  | ({ kind: 'double'; value: number } & Span)
  | ({ kind: 'string'; parts: StringPart[] } & Span)
  | ({ kind: 'bool'; value: boolean } & Span)
  | ({ kind: 'null' } & Span)
  | ({ kind: 'symbol'; name: string } & Span)
  | ({ kind: 'list'; typeArguments: TypeSyntax[] | undefined; elements: CollectionElement[]; isConst: boolean } & Span)
  | ({
      kind: 'setOrMap';
      typeArguments: TypeSyntax[] | undefined;
      elements: CollectionElement[];
      isConst: boolean;
    } & Span)
  | ({ kind: 'record'; fields: RecordLiteralField[]; isConst: boolean } & Span)
  | ({ kind: 'identifier'; name: string } & Span)
  | ({ kind: 'this' } & Span)
  | ({ kind: 'super' } & Span)
  | ({ kind: 'member'; object: Expression; name: string; nullAware: boolean } & Span)
  | ({ kind: 'index'; object: Expression; index: Expression; nullAware: boolean } & Span)
  | ({ kind: 'call'; callee: Expression; typeArguments: TypeSyntax[] | undefined; arguments: Arguments } & Span)
  /** Construction with a keyword or through a constructor selector. */
  | ({
      kind: 'new';
      type: TypeSyntax;
      constructorName: string | undefined;
      arguments: Arguments;
      isConst: boolean;
      isSelectorCall: boolean;
    } & Span)
  | ({ kind: 'assign'; target: Expression; operator: string; value: Expression } & Span)
  | ({ kind: 'patternAssign'; pattern: Pattern; value: Expression } & Span)
  | ({ kind: 'prefix'; operator: '-' | '!' | '~' | '++' | '--'; operand: Expression } & Span)
  | ({ kind: 'postfix'; operator: '++' | '--'; operand: Expression } & Span)
  | ({ kind: 'nullAssert'; operand: Expression } & Span)
  | ({ kind: 'binary'; operator: string; left: Expression; right: Expression } & Span)
  | ({ kind: 'conditional'; condition: Expression; consequent: Expression; alternative: Expression } & Span)
  | ({ kind: 'is'; value: Expression; type: TypeSyntax; negated: boolean } & Span)
  | ({ kind: 'as'; value: Expression; type: TypeSyntax } & Span)
  | ({ kind: 'throw'; value: Expression } & Span)
  | ({
      kind: 'function';
      typeParameters: TypeParameter[];
      parameters: FormalParameters;
      body: FunctionBody;
    } & Span)
  | ({ kind: 'cascade'; target: Expression; sections: CascadeSection[] } & Span)
  | ({ kind: 'switch'; subject: Expression; cases: SwitchExpressionCase[] } & Span)
  /** `.red`, `.new(…)`, or `.parse(…)` with the type taken from the context. */
  | ({ kind: 'dotShorthand'; name: string; arguments: Arguments | undefined; isConst: boolean } & Span)
  | ({ kind: 'instantiation'; target: Expression; typeArguments: TypeSyntax[] } & Span)
  /** `C.new` or `C.named` without a call. */
  | ({ kind: 'constructorTearoff'; type: TypeSyntax; name: string | undefined } & Span)
  | ({ kind: 'parenthesized'; expression: Expression } & Span)
  | ({ kind: 'await'; value: Expression } & Span);

export interface CascadeSection extends Span {
  nullAware: boolean;
  /** The selectors after `..`, applied to the cascade's target, then an optional assignment. */
  selectors: CascadeSelector[];
  assignment: { operator: string; value: Expression } | undefined;
}

export type CascadeSelector =
  | ({ kind: 'member'; name: string; nullAware: boolean } & Span)
  | ({ kind: 'index'; index: Expression; nullAware: boolean } & Span)
  | ({ kind: 'call'; typeArguments: TypeSyntax[] | undefined; arguments: Arguments } & Span)
  | ({ kind: 'nullAssert' } & Span);

export interface SwitchExpressionCase extends Span {
  pattern: Pattern;
  guard: Expression | undefined;
  body: Expression;
}
