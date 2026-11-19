/** The syntax tree of a C# program, converted from tree-sitter's tree with stage C and D syntax already rejected. */

/** Where a node starts, by 0-based row and column, which diagnostics and steps refer to. */
export interface Position {
  row: number;
  column: number;
}

export type TypeNode =
  | ({ kind: 'predefinedType'; name: string } & Position)
  | ({ kind: 'namedType'; name: string; typeArgs: TypeNode[] | undefined } & Position)
  | ({ kind: 'qualifiedType'; left: TypeNode; name: string; typeArgs: TypeNode[] | undefined } & Position)
  | ({ kind: 'arrayType'; element: TypeNode; rank: number } & Position)
  | ({ kind: 'nullableType'; inner: TypeNode } & Position)
  | ({ kind: 'tupleType'; elements: { type: TypeNode; name: string | undefined }[] } & Position)
  | ({ kind: 'varType' } & Position);

export type Modifier =
  | 'public'
  | 'private'
  | 'protected'
  | 'internal'
  | 'static'
  | 'readonly'
  | 'const'
  | 'abstract'
  | 'virtual'
  | 'override'
  | 'sealed'
  | 'new'
  | 'extern'
  | 'this'
  | 'ref'
  | 'out'
  | 'in'
  | 'params';

export interface Modifiers {
  set: ReadonlySet<Modifier>;
  /** The position of each modifier, for diagnostics about one of them. */
  positions: ReadonlyMap<Modifier, Position>;
}

export interface Parameter extends Position {
  name: string;
  type: TypeNode | undefined;
  modifier: 'ref' | 'out' | 'in' | 'params' | 'this' | undefined;
  defaultValue: Expression | undefined;
}

export interface Argument extends Position {
  name: string | undefined;
  modifier: 'ref' | 'out' | 'in' | undefined;
  value: Expression;
}

export type LiteralValue =
  | { type: 'int'; value: bigint; suffix: '' | 'u' | 'l' | 'ul'; text: string }
  | { type: 'real'; text: string; suffix: '' | 'f' | 'd' | 'm' }
  | { type: 'char'; value: number }
  | { type: 'string'; value: string }
  | { type: 'bool'; value: boolean }
  | { type: 'null' };

export interface InterpolationPart {
  /** Literal text, or an interpolation hole. */
  text?: string;
  hole?: { expression: Expression; alignment: Expression | undefined; format: string | undefined };
}

export type Initializer =
  | ({ kind: 'collectionInitializer'; elements: Expression[] } & Position)
  | ({ kind: 'objectInitializer'; members: MemberInitializer[] } & Position);

export type MemberInitializer =
  | ({ kind: 'memberAssign'; name: string; value: Expression | Initializer } & Position)
  | ({ kind: 'indexAssign'; args: Argument[]; value: Expression | Initializer } & Position);

export interface CollectionElement extends Position {
  spread: boolean;
  value: Expression;
}

export interface LambdaParameter extends Position {
  name: string;
  type: TypeNode | undefined;
  modifier: 'ref' | 'out' | 'in' | undefined;
}

export interface SwitchArm extends Position {
  pattern: Pattern;
  guard: Expression | undefined;
  value: Expression;
}

export type QueryClause =
  | ({ kind: 'from'; name: string; type: TypeNode | undefined; source: Expression } & Position)
  | ({ kind: 'let'; name: string; value: Expression } & Position)
  | ({ kind: 'where'; condition: Expression } & Position)
  | ({
      kind: 'join';
      name: string;
      type: TypeNode | undefined;
      source: Expression;
      outerKey: Expression;
      innerKey: Expression;
      into: string | undefined;
    } & Position)
  | ({ kind: 'orderby'; orderings: { key: Expression; descending: boolean }[] } & Position)
  | ({ kind: 'select'; value: Expression } & Position)
  | ({ kind: 'group'; value: Expression; key: Expression } & Position)
  | ({ kind: 'into'; name: string } & Position);

export type Expression =
  | ({ kind: 'literal'; value: LiteralValue } & Position)
  | ({ kind: 'interpolated'; parts: InterpolationPart[] } & Position)
  | ({ kind: 'name'; name: string; typeArgs: TypeNode[] | undefined } & Position)
  | ({ kind: 'predefinedTypeName'; name: string } & Position)
  | ({ kind: 'this' } & Position)
  | ({ kind: 'base' } & Position)
  | ({
      kind: 'memberAccess';
      target: Expression;
      name: string;
      typeArgs: TypeNode[] | undefined;
      nameRow: number;
    } & Position)
  | ({ kind: 'conditionalAccess'; target: Expression; access: Expression } & Position)
  /** The receiver of `?.`, which a conditional access's `access` starts from. */
  | ({ kind: 'conditionalReceiver' } & Position)
  | ({ kind: 'invocation'; target: Expression; args: Argument[] } & Position)
  | ({ kind: 'elementAccess'; target: Expression; args: Argument[] } & Position)
  | ({ kind: 'new'; type: TypeNode; args: Argument[] | undefined; initializer: Initializer | undefined } & Position)
  | ({ kind: 'implicitNew'; args: Argument[]; initializer: Initializer | undefined } & Position)
  | ({
      kind: 'newArray';
      type: TypeNode;
      sizes: (Expression | undefined)[];
      initializer: ArrayInitializer | undefined;
    } & Position)
  | ({ kind: 'implicitNewArray'; initializer: ArrayInitializer } & Position)
  | ArrayInitializer
  | ({ kind: 'collection'; elements: CollectionElement[] } & Position)
  | ({ kind: 'anonymousObject'; members: { name: string | undefined; value: Expression }[] } & Position)
  | ({ kind: 'unary'; operator: '-' | '+' | '!' | '~'; operand: Expression } & Position)
  | ({ kind: 'increment'; operator: '++' | '--'; prefix: boolean; operand: Expression } & Position)
  | ({ kind: 'nullForgiving'; operand: Expression } & Position)
  | ({ kind: 'binary'; operator: string; left: Expression; right: Expression; operatorRow: number } & Position)
  | ({ kind: 'assign'; operator: string; target: Expression; value: Expression } & Position)
  | ({ kind: 'conditional'; condition: Expression; whenTrue: Expression; whenFalse: Expression } & Position)
  | ({ kind: 'cast'; type: TypeNode; operand: Expression } & Position)
  | ({ kind: 'as'; operand: Expression; type: TypeNode } & Position)
  | ({ kind: 'is'; operand: Expression; pattern: Pattern } & Position)
  | ({
      kind: 'lambda';
      parameters: LambdaParameter[];
      body: Expression | Block;
      isStatic: boolean;
      returnType: TypeNode | undefined;
      /** Whether a query clause stands for the lambda, whose conversion errors Roslyn reports without CS1662. */
      isQuery?: true;
    } & Position)
  | ({ kind: 'default'; type: TypeNode | undefined } & Position)
  | ({ kind: 'declaration'; type: TypeNode; designation: Designation } & Position)
  | ({ kind: 'tuple'; elements: Argument[] } & Position)
  | ({ kind: 'switch'; value: Expression; arms: SwitchArm[] } & Position)
  | ({ kind: 'throw'; value: Expression } & Position)
  | ({ kind: 'with'; value: Expression; members: MemberInitializer[] } & Position)
  | ({ kind: 'query'; clauses: QueryClause[] } & Position);

export type ArrayInitializer = { kind: 'arrayInitializer'; elements: (Expression | ArrayInitializer)[] } & Position;

/** What a deconstructing declaration or `out var` declares: one name, a discard, or a parenthesized list. */
export type Designation =
  /** A variable, with its own type in a deconstruction such as `foreach ((int n, string s) in pairs)`. */
  | ({ kind: 'single'; name: string; type?: TypeNode } & Position)
  | ({ kind: 'discard' } & Position)
  | ({ kind: 'parenthesized'; elements: Designation[] } & Position);

export type Pattern =
  | ({ kind: 'constantPattern'; value: Expression } & Position)
  | ({ kind: 'declarationPattern'; type: TypeNode; designation: Designation } & Position)
  | ({ kind: 'typePattern'; type: TypeNode } & Position)
  | ({ kind: 'varPattern'; designation: Designation } & Position)
  | ({ kind: 'discardPattern' } & Position)
  | ({ kind: 'relationalPattern'; operator: '<' | '<=' | '>' | '>='; value: Expression } & Position)
  | ({ kind: 'notPattern'; pattern: Pattern } & Position)
  | ({ kind: 'andPattern'; left: Pattern; right: Pattern } & Position)
  | ({ kind: 'orPattern'; left: Pattern; right: Pattern } & Position)
  | ({
      kind: 'recursivePattern';
      type: TypeNode | undefined;
      positional: Subpattern[] | undefined;
      properties: Subpattern[] | undefined;
      designation: Designation | undefined;
    } & Position);

export interface Subpattern extends Position {
  /** The member path of a property subpattern (`A.B: p`), or undefined for a positional one. */
  names: string[] | undefined;
  pattern: Pattern;
}

export interface Block extends Position {
  kind: 'block';
  statements: Statement[];
  endRow: number;
}

export interface VariableDeclarator extends Position {
  name: string;
  initializer: Expression | ArrayInitializer | undefined;
}

export interface SwitchSection extends Position {
  labels: SwitchLabel[];
  statements: Statement[];
}

export type SwitchLabel =
  | ({ kind: 'case'; pattern: Pattern; guard: Expression | undefined } & Position)
  | ({ kind: 'default' } & Position);

export interface CatchClause extends Position {
  type: TypeNode | undefined;
  name: string | undefined;
  filter: Expression | undefined;
  body: Block;
}

export type Statement =
  | Block
  | ({ kind: 'empty' } & Position)
  | ({ kind: 'expression'; expression: Expression } & Position)
  | ({ kind: 'localDeclaration'; isConst: boolean; type: TypeNode; declarators: VariableDeclarator[] } & Position)
  | ({ kind: 'deconstruction'; designation: Designation; value: Expression } & Position)
  | ({ kind: 'localFunction'; declaration: MethodDeclaration } & Position)
  | ({ kind: 'if'; condition: Expression; consequence: Statement; alternative: Statement | undefined } & Position)
  | ({ kind: 'while'; condition: Expression; body: Statement } & Position)
  | ({ kind: 'do'; body: Statement; condition: Expression; conditionRow: number } & Position)
  | ({
      kind: 'for';
      initializer:
        | { kind: 'declaration'; type: TypeNode; declarators: VariableDeclarator[] }
        | { kind: 'expressions'; expressions: Expression[] }
        | undefined;
      condition: Expression | undefined;
      updates: Expression[];
      body: Statement;
    } & Position)
  | ({ kind: 'foreach'; type: TypeNode; variable: Designation; collection: Expression; body: Statement } & Position)
  | ({ kind: 'switch'; value: Expression; sections: SwitchSection[] } & Position)
  | ({ kind: 'break' } & Position)
  | ({ kind: 'continue' } & Position)
  | ({ kind: 'return'; value: Expression | undefined } & Position)
  | ({ kind: 'throw'; value: Expression | undefined } & Position)
  | ({ kind: 'try'; body: Block; catches: CatchClause[]; finally: Block | undefined } & Position);

export interface TypeParameterDeclaration extends Position {
  name: string;
  variance: 'in' | 'out' | undefined;
}

export type Constraint =
  | ({ kind: 'class'; nullable: boolean } & Position)
  | ({ kind: 'struct' } & Position)
  | ({ kind: 'notnull' } & Position)
  | ({ kind: 'new' } & Position)
  | ({ kind: 'type'; type: TypeNode } & Position);

export interface ConstraintClause extends Position {
  name: string;
  constraints: Constraint[];
}

export interface MethodDeclaration extends Position {
  kind: 'method';
  modifiers: Modifiers;
  returnType: TypeNode;
  name: string;
  typeParameters: TypeParameterDeclaration[];
  constraints: ConstraintClause[];
  parameters: Parameter[];
  body: Block | Expression | undefined;
  /** The row of the body's `{` or `=>`, up to which an `// atomic` annotation may mark the method. */
  bodyRow: number;
  /** The row where the declaration starts, from which an `// atomic` annotation may mark the method. */
  startRow: number;
}

export interface ConstructorDeclaration extends Position {
  kind: 'constructor';
  modifiers: Modifiers;
  name: string;
  parameters: Parameter[];
  initializer: ({ kind: 'base' | 'this'; args: Argument[] } & Position) | undefined;
  body: Block | Expression | undefined;
  bodyRow: number;
  startRow: number;
}

export interface DestructorDeclaration extends Position {
  kind: 'destructor';
  name: string;
  body: Block | Expression | undefined;
}

export interface FieldDeclaration extends Position {
  kind: 'field';
  modifiers: Modifiers;
  type: TypeNode;
  declarators: VariableDeclarator[];
}

export interface Accessor extends Position {
  kind: 'get' | 'set' | 'init';
  modifiers: Modifiers;
  body: Block | Expression | undefined;
}

export interface PropertyDeclaration extends Position {
  kind: 'property';
  modifiers: Modifiers;
  type: TypeNode;
  name: string;
  /** The accessors, or for an expression-bodied property `int P => x;`, a getter with that body. */
  accessors: Accessor[];
  initializer: Expression | ArrayInitializer | undefined;
  /** Whether the property is written with an expression body, which makes it read-only. */
  isExpressionBodied: boolean;
}

export interface IndexerDeclaration extends Position {
  kind: 'indexer';
  modifiers: Modifiers;
  type: TypeNode;
  parameters: Parameter[];
  accessors: Accessor[];
}

export interface EventFieldDeclaration extends Position {
  kind: 'event';
  modifiers: Modifiers;
  type: TypeNode;
  declarators: VariableDeclarator[];
}

export interface OperatorDeclaration extends Position {
  kind: 'operator';
  modifiers: Modifiers;
  returnType: TypeNode;
  operator: string;
  parameters: Parameter[];
  body: Block | Expression | undefined;
  bodyRow: number;
  startRow: number;
}

export interface EnumMember extends Position {
  name: string;
  value: Expression | undefined;
}

export interface TypeDeclaration extends Position {
  kind: 'type';
  typeKind: 'class' | 'struct' | 'interface' | 'enum' | 'delegate';
  isRecord: boolean;
  modifiers: Modifiers;
  name: string;
  typeParameters: TypeParameterDeclaration[];
  constraints: ConstraintClause[];
  /** The primary constructor's parameters (`record P(int X)`, `class C(int x)`). */
  primaryParameters: Parameter[] | undefined;
  bases: TypeNode[];
  /** The arguments that a primary constructor passes to the base class (`: Base(x)`). */
  baseArguments: Argument[] | undefined;
  members: MemberDeclaration[];
  enumMembers: EnumMember[];
  enumUnderlyingType: TypeNode | undefined;
  /** For a delegate type, its return type and parameters. */
  delegateReturnType: TypeNode | undefined;
  delegateParameters: Parameter[];
  endRow: number;
}

export type MemberDeclaration =
  | MethodDeclaration
  | ConstructorDeclaration
  | DestructorDeclaration
  | FieldDeclaration
  | PropertyDeclaration
  | IndexerDeclaration
  | EventFieldDeclaration
  | OperatorDeclaration
  | TypeDeclaration;

export interface NamespaceDeclaration extends Position {
  kind: 'namespace';
  name: string[];
  usings: UsingDirective[];
  members: (TypeDeclaration | NamespaceDeclaration)[];
}

export interface UsingDirective extends Position {
  name: string[];
}

export interface CompilationUnit {
  usings: UsingDirective[];
  /** The top-level statements, which form the program's entry point when there are any. */
  statements: Statement[];
  members: (TypeDeclaration | NamespaceDeclaration)[];
  /** The rows of `// atomic` annotations, which the trace uses. */
  sourceRows: number;
}
