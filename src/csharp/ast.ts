import type { BuildOptions } from './preprocessor';

/** The syntax tree of a C# program, converted from tree-sitter's tree with stage C and D syntax already rejected. */

/** Where a node starts, by 0-based row and column, which diagnostics and steps refer to. */
export interface Position {
  row: number;
  column: number;
}

export type TypeNode =
  | ({ kind: 'predefinedType'; name: string } & Position)
  /** `ref T` or `ref readonly T`, the type of a ref local or of what a method returns by reference. */
  | ({ kind: 'refType'; type: TypeNode; isReadonly: boolean } & Position)
  /** `T*`, whose use outside an unsafe context is an error. */
  | ({ kind: 'pointerType'; element: TypeNode; isUnsafe: boolean } & Position)
  /** `delegate*<A, R>`, a function pointer of managed calling convention. */
  | ({ kind: 'functionPointerType'; parameters: TypeNode[]; returnType: TypeNode; isUnsafe: boolean } & Position)
  | ({
      kind: 'namedType';
      name: string;
      typeArgs: TypeNode[] | undefined;
      /** For an unbound generic type in `typeof(List<>)`, how many type arguments it leaves out. */
      unboundArity?: number;
    } & Position)
  | ({ kind: 'qualifiedType'; left: TypeNode; name: string; typeArgs: TypeNode[] | undefined } & Position)
  /** A name qualified by a namespace alias, as `global::System` or `G::List<int>`. */
  | ({ kind: 'aliasQualifiedType'; alias: string; name: string; typeArgs: TypeNode[] | undefined } & Position)
  | ({ kind: 'arrayType'; element: TypeNode; rank: number } & Position)
  | ({ kind: 'nullableType'; inner: TypeNode } & Position)
  | ({ kind: 'tupleType'; elements: { type: TypeNode; name: string | undefined }[] } & Position)
  | ({ kind: 'varType' } & Position);

export type Modifier =
  | 'unsafe'
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
  | 'params'
  | 'partial'
  | 'required'
  | 'file'
  | 'volatile'
  | 'async';

export interface Modifiers {
  set: ReadonlySet<Modifier>;
  /** The position of each modifier, for diagnostics about one of them. */
  positions: ReadonlyMap<Modifier, Position>;
}

/** An attribute (`[Obsolete("x")]`), with the target its list names (`[return: ...]`, `[field: ...]`), if any. */
export interface AttributeNode extends Position {
  name: TypeNode;
  /** The positional arguments and the named ones (`x: 1`), which go to the attribute's constructor. */
  args: Argument[];
  /** The field and property assignments (`X = 1`). */
  assignments: { name: string; value: Expression; row: number; column: number }[];
  target: string | undefined;
}

/** A declaration's attributes, which binding checks and gives their meaning. */
export interface Attributed {
  attributes?: AttributeNode[];
}

export interface Parameter extends Position, Attributed {
  name: string;
  type: TypeNode | undefined;
  modifier: 'ref' | 'out' | 'in' | 'params' | undefined;
  /** Whether the parameter is an extension method's receiver (`this int x`). */
  isThis: boolean;
  defaultValue: Expression | undefined;
}

export interface Argument extends Position {
  name: string | undefined;
  modifier: 'ref' | 'out' | 'in' | undefined;
  value: Expression;
  /** The value's source text, which a `[CallerArgumentExpression]` parameter receives. */
  text?: string;
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
  | ({ kind: 'aliasQualified'; alias: string; name: string; typeArgs: TypeNode[] | undefined } & Position)
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
  | ({ kind: 'implicitNewArray'; rank: number; initializer: ArrayInitializer } & Position)
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
      attributes?: AttributeNode[];
      parameters: LambdaParameter[];
      body: Expression | Block;
      isStatic: boolean;
      returnType: TypeNode | undefined;
      /** Whether a query clause stands for the lambda, whose conversion errors Roslyn reports without CS1662. */
      isQuery?: true;
      /** An anonymous method written without a parameter list (`delegate { }`), which fits any parameters but `out`. */
      omitsParameters?: true;
      /** Whether `delegate (...) { }` wrote it rather than `=>`, which some messages name differently. */
      isAnonymousMethod?: true;
      isAsync?: true;
    } & Position)
  | ({ kind: 'default'; type: TypeNode | undefined } & Position)
  | ({ kind: 'declaration'; type: TypeNode; designation: Designation } & Position)
  | ({ kind: 'tuple'; elements: Argument[] } & Position)
  | ({ kind: 'switch'; value: Expression; arms: SwitchArm[] } & Position)
  | ({ kind: 'throw'; value: Expression } & Position)
  | ({ kind: 'with'; value: Expression; members: MemberInitializer[] } & Position)
  | ({ kind: 'query'; clauses: QueryClause[] } & Position)
  | ({ kind: 'typeof'; type: TypeNode } & Position)
  | ({ kind: 'sizeof'; type: TypeNode; isUnsafe?: boolean } & Position)
  /** `ref x`, the variable that a ref local refers to or a method returns by reference. */
  | ({ kind: 'refExpression'; operand: Expression } & Position)
  /** `&x`, the address of a variable, or of a method for a function pointer. */
  | ({ kind: 'addressOf'; operand: Expression; isUnsafe: boolean } & Position)
  /** `*p`, the variable a pointer points to; `p->X` is `(*p).X`. */
  | ({ kind: 'deref'; operand: Expression; isUnsafe: boolean } & Position)
  /** `stackalloc T[n]` or `stackalloc[] { ... }`, a buffer on the stack. */
  | ({
      kind: 'stackalloc';
      elementType: TypeNode | undefined;
      count: Expression | undefined;
      initializer: Expression[] | undefined;
      isUnsafe: boolean;
    } & Position)
  | ({ kind: 'await'; operand: Expression } & Position)
  /** `^n`, an index from the end. */
  | ({ kind: 'fromEnd'; operand: Expression } & Position)
  /** `a..b`, a range whose omitted ends are the start and the end. */
  | ({ kind: 'range'; start: Expression | undefined; end: Expression | undefined } & Position)
  /** `checked(...)` or `unchecked(...)`, which sets whether integral arithmetic inside throws on overflow. */
  | ({ kind: 'checked'; isChecked: boolean; operand: Expression } & Position);

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
  /** `[p1, .. rest, p2]`, which matches a countable, indexable value by its elements. */
  | ({ kind: 'listPattern'; elements: Pattern[]; designation: Designation | undefined } & Position)
  /** `..` or `.. p` in a list pattern, which matches the elements between the patterns before and after it. */
  | ({ kind: 'slicePattern'; pattern: Pattern | undefined } & Position)
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
  | ({
      kind: 'localDeclaration';
      isConst: boolean;
      type: TypeNode;
      declarators: VariableDeclarator[];
      /** A `using` declaration (`using var r = ...;`), which disposes its variables at the end of the enclosing block. */
      using?: 'using' | 'await using';
    } & Position)
  | ({ kind: 'deconstruction'; designation: Designation; value: Expression } & Position)
  | ({ kind: 'unsafe'; body: Block } & Position)
  | ({ kind: 'fixed'; type: TypeNode; declarators: VariableDeclarator[]; body: Statement } & Position)
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
  | ({
      kind: 'foreach';
      type: TypeNode;
      variable: Designation;
      collection: Expression;
      body: Statement;
      /** `await foreach`, over an async stream. */
      isAwait?: true;
    } & Position)
  | ({ kind: 'switch'; value: Expression; sections: SwitchSection[] } & Position)
  | ({ kind: 'break' } & Position)
  | ({ kind: 'continue' } & Position)
  | ({ kind: 'return'; value: Expression | undefined } & Position)
  | ({ kind: 'throw'; value: Expression | undefined } & Position)
  | ({ kind: 'try'; body: Block; catches: CatchClause[]; finally: Block | undefined } & Position)
  | ({ kind: 'checked'; isChecked: boolean; body: Block } & Position)
  | ({ kind: 'lock'; value: Expression; body: Statement } & Position)
  | ({ kind: 'goto'; target: GotoTarget } & Position)
  | ({ kind: 'labeled'; label: string; statement: Statement } & Position)
  /** `yield return value;`, or `yield break;` without a value. */
  | ({ kind: 'yield'; value: Expression | undefined } & Position)
  | ({
      kind: 'using';
      /** The declared resources, or the expression whose value is the resource. */
      resource:
        | { kind: 'declaration'; type: TypeNode; declarators: VariableDeclarator[] }
        | { kind: 'expression'; value: Expression };
      body: Statement;
      isAwait: boolean;
    } & Position);

export type GotoTarget = { kind: 'label'; name: string } | { kind: 'case'; value: Expression } | { kind: 'default' };

export interface TypeParameterDeclaration extends Position, Attributed {
  name: string;
  variance: 'in' | 'out' | undefined;
}

export type Constraint =
  | ({ kind: 'class'; nullable: boolean } & Position)
  | ({ kind: 'struct' } & Position)
  | ({ kind: 'notnull' } & Position)
  | ({ kind: 'unmanaged' } & Position)
  | ({ kind: 'default' } & Position)
  | ({ kind: 'new' } & Position)
  | ({ kind: 'type'; type: TypeNode } & Position);

export interface ConstraintClause extends Position {
  name: string;
  constraints: Constraint[];
}

export interface MethodDeclaration extends Position, Attributed {
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
  /** A partial method with only its defining declaration, whose calls C# removes with their arguments. */
  isRemovedPartial?: boolean;
  /** The interface of an explicit implementation (`void IShape.Draw()`). */
  explicitInterface?: TypeNode;
  /**
   * A member of an extension block (`extension(int n) { ... }`), which the converter turns into a method of the
   * enclosing static class: an extension property's getter, or a static member of the receiver's type.
   */
  extension?: { property?: string; staticReceiver?: TypeNode };
}

export interface ConstructorDeclaration extends Position, Attributed {
  kind: 'constructor';
  modifiers: Modifiers;
  name: string;
  parameters: Parameter[];
  initializer: ({ kind: 'base' | 'this'; args: Argument[] } & Position) | undefined;
  body: Block | Expression | undefined;
  bodyRow: number;
  startRow: number;
}

export interface DestructorDeclaration extends Position, Attributed {
  kind: 'destructor';
  name: string;
  body: Block | Expression | undefined;
}

export interface FieldDeclaration extends Position, Attributed {
  kind: 'field';
  modifiers: Modifiers;
  type: TypeNode;
  declarators: VariableDeclarator[];
}

export interface Accessor extends Position, Attributed {
  kind: 'get' | 'set' | 'init';
  modifiers: Modifiers;
  body: Block | Expression | undefined;
}

export interface PropertyDeclaration extends Position, Attributed {
  kind: 'property';
  modifiers: Modifiers;
  type: TypeNode;
  name: string;
  /** The accessors, or for an expression-bodied property `int P => x;`, a getter with that body. */
  accessors: Accessor[];
  initializer: Expression | ArrayInitializer | undefined;
  /** Whether the property is written with an expression body, which makes it read-only. */
  isExpressionBodied: boolean;
  explicitInterface?: TypeNode;
}

export interface IndexerDeclaration extends Position, Attributed {
  kind: 'indexer';
  modifiers: Modifiers;
  type: TypeNode;
  parameters: Parameter[];
  accessors: Accessor[];
  explicitInterface?: TypeNode;
}

/** An event with its own `add` and `remove` accessors, which keeps no delegate field. */
export interface EventAccessorDeclaration extends Position, Attributed {
  kind: 'eventAccessors';
  modifiers: Modifiers;
  type: TypeNode;
  name: string;
  add: Block | Expression | undefined;
  remove: Block | Expression | undefined;
  explicitInterface?: TypeNode;
}

export interface EventFieldDeclaration extends Position, Attributed {
  kind: 'event';
  modifiers: Modifiers;
  type: TypeNode;
  declarators: VariableDeclarator[];
}

export interface OperatorDeclaration extends Position, Attributed {
  kind: 'operator';
  modifiers: Modifiers;
  returnType: TypeNode;
  /** The operator's token, or `implicit` or `explicit` for a conversion operator. */
  operator: string;
  /** Whether the operator is `checked`, which a checked context uses in place of the regular one. */
  isChecked: boolean;
  parameters: Parameter[];
  body: Block | Expression | undefined;
  bodyRow: number;
  startRow: number;
}

export interface EnumMember extends Position, Attributed {
  name: string;
  value: Expression | undefined;
}

export interface TypeDeclaration extends Position, Attributed {
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
  | EventAccessorDeclaration
  | OperatorDeclaration
  | TypeDeclaration;

export interface NamespaceDeclaration extends Position {
  kind: 'namespace';
  name: string[];
  usings: UsingDirective[];
  members: (TypeDeclaration | NamespaceDeclaration)[];
}

export type UsingDirective = (
  | { kind: 'namespace'; name: TypeNode }
  | { kind: 'static'; name: TypeNode }
  | { kind: 'alias'; alias: string; name: TypeNode }
) & { isGlobal: boolean } & Position;

export interface CompilationUnit {
  usings: UsingDirective[];
  /** The top-level statements, which form the program's entry point when there are any. */
  statements: Statement[];
  members: (TypeDeclaration | NamespaceDeclaration)[];
  /** The rows of `// atomic` annotations, which the trace uses. */
  sourceRows: number;
  /** The compiler options that the program's `#:property` directives set; the library has none. */
  options?: BuildOptions;
  /** The `[assembly: ...]` and `[module: ...]` attributes. */
  attributes?: AttributeNode[];
}
