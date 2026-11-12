/** Where a construct starts in the source, 0-based. */
export interface Span {
  row: number;
  column: number;
}

export interface File {
  packageName: string;
  packageSpan: Span;
  imports: ImportSpec[];
  declarations: TopLevelDeclaration[];
}

export interface ImportSpec extends Span {
  path: string;
  /** The name the file gives the package, or `_`; undefined for the package's own name. */
  alias?: string;
}

export type TopLevelDeclaration = FunctionDeclaration | DeclarationStatement;

export interface FunctionDeclaration extends Span {
  kind: 'func';
  name: string;
  nameSpan: Span;
  receiver?: Receiver;
  typeParameters: TypeParameter[];
  signature: SignatureSyntax;
  body?: Block;
  /** The row of the body's `{`, through which an `// atomic` annotation may mark the function. */
  headerEndRow: number;
}

export interface Receiver extends Span {
  name?: string;
  pointer: boolean;
  typeName: string;
  /** The receiver type's parameters as the method names them, as in `func (l *List[T]) Push(v T)`. */
  typeArguments: string[];
}

export interface TypeParameter extends Span {
  name: string;
  constraint: TypeExpression;
}

export interface Parameter extends Span {
  name?: string;
  type: TypeExpression;
}

export interface SignatureSyntax {
  parameters: Parameter[];
  results: Parameter[];
}

export type DeclarationStatement = VarDeclaration | ConstDeclaration | TypeDeclaration;

export interface VarSpec extends Span {
  names: NameSpan[];
  type?: TypeExpression;
  values: Expression[];
}

export interface NameSpan extends Span {
  name: string;
}

export interface VarDeclaration extends Span {
  kind: 'var';
  specs: VarSpec[];
}

export interface ConstSpec extends Span {
  names: NameSpan[];
  type?: TypeExpression;
  values: Expression[];
}

export interface ConstDeclaration extends Span {
  kind: 'const';
  specs: ConstSpec[];
}

export interface TypeSpec extends Span {
  name: string;
  typeParameters: TypeParameter[];
  type: TypeExpression;
}

export interface TypeDeclaration extends Span {
  kind: 'type';
  specs: TypeSpec[];
}

// Types ---------------------------------------------------------------------------------------------------------------

export type TypeExpression =
  | ({ kind: 'name'; package?: string; name: string; typeArguments: TypeExpression[] } & Span)
  | ({ kind: 'pointer'; element: TypeExpression } & Span)
  | ({ kind: 'slice'; element: TypeExpression } & Span)
  | ({ kind: 'array'; length: Expression | undefined; element: TypeExpression } & Span)
  | ({ kind: 'map'; key: TypeExpression; value: TypeExpression } & Span)
  | ({ kind: 'chan'; dir: 'both' | 'send' | 'receive'; element: TypeExpression } & Span)
  | ({ kind: 'func'; signature: SignatureSyntax } & Span)
  | ({ kind: 'struct'; fields: FieldSyntax[] } & Span)
  | ({ kind: 'interface'; methods: MethodSyntax[] } & Span);

export interface FieldSyntax extends Span {
  /** Undefined for an embedded field, which takes its type's name. */
  name?: string;
  type: TypeExpression;
}

export interface MethodSyntax extends Span {
  name: string;
  signature: SignatureSyntax;
}

// Expressions ---------------------------------------------------------------------------------------------------------

export type Expression =
  | ({ kind: 'name'; name: string } & Span)
  | ({ kind: 'int'; value: bigint; text: string } & Span)
  | ({ kind: 'float'; text: string } & Span)
  | ({ kind: 'imaginary'; text: string } & Span)
  | ({ kind: 'rune'; value: number } & Span)
  /** A string, whose value holds UTF-8 bytes as code units. */
  | ({ kind: 'string'; value: string } & Span)
  | CompositeLiteral
  | ({ kind: 'funcLiteral'; signature: SignatureSyntax; body: Block } & Span)
  | ({ kind: 'paren'; expression: Expression } & Span)
  | ({ kind: 'selector'; operand: Expression; field: string; fieldSpan: Span } & Span)
  | ({ kind: 'index'; operand: Expression; indices: Expression[] } & Span)
  | ({ kind: 'slice'; operand: Expression; low?: Expression; high?: Expression; max?: Expression } & Span)
  | ({ kind: 'typeAssert'; operand: Expression; type: TypeExpression } & Span)
  | ({
      kind: 'call';
      callee: Expression;
      typeArguments: TypeExpression[];
      args: Expression[];
    } & Span)
  | ({ kind: 'unary'; operator: string; operand: Expression } & Span)
  | ({ kind: 'binary'; operator: string; left: Expression; right: Expression } & Span)
  /** A type written where an expression may stand, as the callee of a conversion such as `[]byte(s)`. */
  | ({ kind: 'type'; type: TypeExpression } & Span);

export interface CompositeLiteral extends Span {
  kind: 'composite';
  /** Undefined inside another composite literal, whose element type it takes. */
  type: TypeExpression | undefined;
  elements: LiteralElement[];
  /** The row of the closing brace, which Go reports for missing elements. */
  endRow: number;
}

export interface LiteralElement extends Span {
  key?: Expression;
  value: Expression;
}

// Statements ----------------------------------------------------------------------------------------------------------

export interface Block extends Span {
  statements: Statement[];
  endRow: number;
}

export type SimpleStatement =
  | ({ kind: 'expression'; expression: Expression } & Span)
  | ({ kind: 'assign'; operator: string; left: Expression[]; right: Expression[] } & Span)
  | ({ kind: 'define'; left: Expression[]; right: Expression[] } & Span)
  | ({ kind: 'incDec'; operator: '++' | '--'; operand: Expression } & Span)
  | ({ kind: 'send'; channel: Expression; value: Expression } & Span)
  | ({ kind: 'empty' } & Span);

/** One case of a select statement: a send, a receive that may assign or declare, or `default`. */
export interface SelectCase extends Span {
  /** Undefined for `default`. */
  comm:
    | Extract<SimpleStatement, { kind: 'send' }>
    | ({ kind: 'receive'; left: Expression[]; define: boolean; channel: Expression } & Span)
    | undefined;
  body: Statement[];
}

export interface SwitchCase extends Span {
  /** Undefined for `default`. */
  values: Expression[] | undefined;
  body: Statement[];
}

export interface TypeSwitchCase extends Span {
  /** Undefined for `default`; `undefined` entries stand for `nil`. */
  types: (TypeExpression | undefined)[] | undefined;
  body: Statement[];
}

export type Statement =
  | SimpleStatement
  | (DeclarationStatement & { inFunction?: true })
  | ({ kind: 'block'; block: Block } & Span)
  | ({
      kind: 'if';
      init?: SimpleStatement;
      condition: Expression;
      consequence: Block;
      alternative?: Block | Extract<Statement, { kind: 'if' }>;
    } & Span)
  | ({
      kind: 'for';
      init?: SimpleStatement;
      condition?: Expression;
      post?: SimpleStatement;
      body: Block;
    } & Span)
  | ({
      kind: 'range';
      key?: Expression;
      value?: Expression;
      define: boolean;
      range: Expression;
      body: Block;
    } & Span)
  | ({ kind: 'switch'; init?: SimpleStatement; tag?: Expression; cases: SwitchCase[]; endRow: number } & Span)
  | ({
      kind: 'typeSwitch';
      init?: SimpleStatement;
      binding?: NameSpan;
      operand: Expression;
      cases: TypeSwitchCase[];
    } & Span)
  | ({ kind: 'return'; results: Expression[] } & Span)
  | ({ kind: 'break' } & Span)
  | ({ kind: 'continue' } & Span)
  | ({ kind: 'fallthrough' } & Span)
  | ({ kind: 'defer'; call: Expression } & Span)
  | ({ kind: 'go'; call: Expression } & Span)
  | ({ kind: 'select'; cases: SelectCase[] } & Span);
