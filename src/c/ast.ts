/** A part of the program, located by the 0-based row where it starts. */
export interface Span {
  row: number;
}

// Declarations ------------------------------------------------------------------------------------------------------

export type StorageClass = 'typedef' | 'extern' | 'static' | 'auto' | 'register';

export interface Qualifiers {
  isConst: boolean;
  isVolatile: boolean;
}

export interface Specifiers extends Span {
  storage?: StorageClass;
  qualifiers: Qualifiers;
  type: TypeSpecifier;
}

export type TypeSpecifier =
  /** The words of a builtin type, such as `unsigned long` or `_Bool`; no words is the implicit `int` C17 rejects. */
  | ({ kind: 'builtin'; words: string[] } & Span)
  | ({ kind: 'typedefName'; name: string } & Span)
  | ({ kind: 'struct' | 'union'; tag?: string; fields?: FieldDeclaration[] } & Span)
  | ({ kind: 'enum'; tag?: string; enumerators?: Enumerator[] } & Span);

export interface FieldDeclaration extends Span {
  specifiers: Specifiers;
  declarators: { declarator: Declarator; bitWidth?: Expression; row: number }[];
}

export interface Enumerator extends Span {
  name: string;
  value?: Expression;
}

/** How a declarator derives a declared type from its specifiers, read from the name outward. */
export type Declarator =
  | ({ kind: 'name'; name?: string } & Span)
  | ({ kind: 'pointer'; qualifiers: Qualifiers; inner: Declarator } & Span)
  | ({ kind: 'array'; size?: Expression; inner: Declarator } & Span)
  | ({
      kind: 'function';
      /** The parameters, or undefined for `()`, which declares a function without saying its parameters. */
      params?: Parameter[];
      variadic: boolean;
      inner: Declarator;
    } & Span);

export interface Parameter extends Span {
  specifiers: Specifiers;
  declarator: Declarator;
}

export interface TypeName extends Span {
  specifiers: Specifiers;
  declarator: Declarator;
}

export type Initializer =
  | ({ kind: 'expression'; expression: Expression } & Span)
  | ({ kind: 'list'; items: Initializer[] } & Span);

export interface InitDeclarator extends Span {
  declarator: Declarator;
  init?: Initializer;
}

export interface Declaration extends Span {
  kind: 'declaration';
  specifiers: Specifiers;
  declarators: InitDeclarator[];
  /** Whether a standard header declares it, whose functions the interpreter implements. */
  fromHeader?: string;
}

export interface FunctionDefinition extends Span {
  kind: 'function';
  specifiers: Specifiers;
  declarator: Declarator;
  body: Compound;
  /** The row of the body's `{`, which ends the header that `// atomic` may annotate. */
  bodyRow: number;
}

export type ExternalDeclaration = Declaration | FunctionDefinition;

export interface TranslationUnit {
  items: ExternalDeclaration[];
}

// Statements --------------------------------------------------------------------------------------------------------

export interface Compound extends Span {
  kind: 'compound';
  items: (Statement | Declaration)[];
}

export type Statement =
  | Compound
  | ({ kind: 'expression'; expression?: Expression } & Span)
  | ({ kind: 'if'; condition: Expression; consequent: Statement; alternative?: Statement } & Span)
  | ({ kind: 'while'; condition: Expression; body: Statement } & Span)
  | ({ kind: 'doWhile'; condition: Expression; body: Statement } & Span)
  | ({
      kind: 'for';
      init?: Declaration | Expression;
      condition?: Expression;
      update?: Expression;
      body: Statement;
    } & Span)
  | ({ kind: 'switch'; condition: Expression; body: Statement } & Span)
  /** `case value:` or `default:` (no value), labeling the statement after it. */
  | ({ kind: 'case'; value?: Expression; body: Statement | Declaration } & Span)
  | ({ kind: 'break' } & Span)
  | ({ kind: 'continue' } & Span)
  | ({ kind: 'return'; value?: Expression } & Span)
  | ({ kind: 'goto'; label: string } & Span)
  | ({ kind: 'labeled'; label: string; body: Statement | Declaration } & Span);

// Expressions -------------------------------------------------------------------------------------------------------

export type BinaryOperator =
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '<<'
  | '>>'
  | '&'
  | '|'
  | '^'
  | '&&'
  | '||'
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>=';

export type Expression =
  | ({ kind: 'identifier'; name: string } & Span)
  | ({ kind: 'number'; text: string } & Span)
  | ({ kind: 'char'; text: string } & Span)
  /** Adjacent string literals, which C joins into one. */
  | ({ kind: 'string'; parts: string[] } & Span)
  | ({ kind: 'binary'; operator: BinaryOperator; left: Expression; right: Expression } & Span)
  | ({ kind: 'assign'; operator: BinaryOperator | undefined; left: Expression; right: Expression } & Span)
  | ({ kind: 'unary'; operator: '-' | '+' | '!' | '~'; operand: Expression } & Span)
  | ({ kind: 'deref'; operand: Expression } & Span)
  | ({ kind: 'address'; operand: Expression } & Span)
  | ({ kind: 'update'; operator: '++' | '--'; prefix: boolean; operand: Expression } & Span)
  | ({ kind: 'cast'; typeName: TypeName; operand: Expression } & Span)
  | ({ kind: 'sizeofType'; typeName: TypeName } & Span)
  | ({ kind: 'sizeofExpression'; operand: Expression } & Span)
  | ({ kind: 'conditional'; condition: Expression; consequent: Expression; alternative: Expression } & Span)
  | ({ kind: 'comma'; left: Expression; right: Expression } & Span)
  | ({ kind: 'call'; callee: Expression; args: Expression[] } & Span)
  | ({ kind: 'subscript'; array: Expression; index: Expression } & Span)
  | ({ kind: 'member'; object: Expression; field: string; arrow: boolean } & Span)
  /** A parenthesized expression, which matters to clang only in what it warns about, and to `sizeof (T)`. */
  | ({ kind: 'paren'; expression: Expression } & Span)
  | ({ kind: 'offsetof'; typeName: TypeName; member: string } & Span)
  /** `va_arg(ap, T)`, which tree-sitter parses as an expression of its own. */
  | ({ kind: 'vaArg'; operand: Expression; typeName: TypeName } & Span);

export const NO_QUALIFIERS: Qualifiers = { isConst: false, isVolatile: false };
