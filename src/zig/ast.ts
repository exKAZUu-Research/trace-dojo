/** Where a construct starts and ends in the source, by 0-based rows and columns. */
export interface Span {
  row: number;
  col: number;
  endRow: number;
}

export type AssignOperator =
  | '='
  | '*='
  | '*%='
  | '*|='
  | '/='
  | '%='
  | '+='
  | '+%='
  | '+|='
  | '-='
  | '-%='
  | '-|='
  | '<<='
  | '<<|='
  | '>>='
  | '&='
  | '^='
  | '|=';

export type BinaryOperator =
  | 'or'
  | 'and'
  | '=='
  | '!='
  | '<'
  | '>'
  | '<='
  | '>='
  | '&'
  | '^'
  | '|'
  | 'orelse'
  | '<<'
  | '>>'
  | '<<|'
  | '+'
  | '-'
  | '++'
  | '+%'
  | '-%'
  | '+|'
  | '-|'
  | '*'
  | '/'
  | '%'
  | '**'
  | '*%'
  | '*|'
  | '||';

export type UnaryOperator = '!' | '~' | '-' | '-%' | '&';

/** A capture between bars, such as `|x|`, `|*p|`, or one of the names in `|x, i|`. */
export interface Capture extends Span {
  name: string;
  byPointer: boolean;
}

export interface Label extends Span {
  name: string;
}

export interface ContainerField extends Span {
  /** Undefined for a field of a tuple type, which has a type only. */
  name?: string;
  type?: Expression;
  value?: Expression;
}

export interface FunctionDeclaration extends Span {
  kind: 'fn';
  name: string;
  isPub: boolean;
  isInline: boolean;
  params: Parameter[];
  returnType: Expression;
  /** Whether the return type is written `!T`, an error union whose error set the compiler infers. */
  inferredErrorSet: boolean;
  body: Block;
  /** The row of the body's `{`, the last row of the header, where `// atomic` may stand. */
  bodyRow: number;
}

export interface Parameter extends Span {
  name: string;
  /** Undefined for `anytype`. */
  type?: Expression;
}

export interface VariableDeclaration extends Span {
  kind: 'var';
  name: string;
  isConst: boolean;
  isPub: boolean;
  type?: Expression;
  value?: Expression;
}

export type ContainerMember = FunctionDeclaration | VariableDeclaration;

export interface Container extends Span {
  kind: 'container';
  containerKind: 'struct' | 'enum' | 'union';
  layout: 'auto' | 'extern' | 'packed';
  /** The tag type of `enum(u8)` or `union(Tag)`, or the backing integer of `packed struct(u8)`. */
  argument?: Expression;
  /** Whether a union is written `union(enum)`. */
  taggedByEnum: boolean;
  fields: ContainerField[];
  members: ContainerMember[];
}

export type Expression = Span &
  (
    | { kind: 'integer'; value: bigint }
    | { kind: 'float'; text: string }
    | { kind: 'character'; value: bigint }
    | { kind: 'string'; bytes: number[] }
    | { kind: 'bool'; value: boolean }
    | { kind: 'null' }
    | { kind: 'undefined' }
    | { kind: 'unreachable' }
    | { kind: 'identifier'; name: string }
    | { kind: 'enumLiteral'; name: string }
    | { kind: 'errorValue'; name: string }
    | { kind: 'field'; object: Expression; name: string }
    | { kind: 'index'; object: Expression; index: Expression }
    | {
        kind: 'slice';
        object: Expression;
        start: Expression;
        end?: Expression;
        sentinel?: Expression;
      }
    | { kind: 'deref'; operand: Expression }
    | { kind: 'unwrap'; operand: Expression }
    | { kind: 'call'; callee: Expression; args: Expression[] }
    | { kind: 'builtinCall'; name: string; args: Expression[] }
    | { kind: 'unary'; operator: UnaryOperator; operand: Expression }
    | { kind: 'binary'; operator: BinaryOperator; left: Expression; right: Expression }
    | { kind: 'try'; operand: Expression }
    | { kind: 'catch'; operand: Expression; capture?: Capture; handler: Expression }
    | {
        kind: 'if';
        condition: Expression;
        capture?: Capture;
        consequent: Expression;
        elseCapture?: Capture;
        otherwise?: Expression;
      }
    | {
        kind: 'while';
        label?: Label;
        isInline: boolean;
        condition: Expression;
        capture?: Capture;
        continueExpression?: Expression;
        body: Expression;
        elseCapture?: Capture;
        otherwise?: Expression;
      }
    | {
        kind: 'for';
        label?: Label;
        isInline: boolean;
        operands: ForOperand[];
        captures: Capture[];
        body: Expression;
        otherwise?: Expression;
      }
    | { kind: 'switch'; label?: Label; operand: Expression; cases: SwitchCase[] }
    | { kind: 'block'; label?: Label; statements: Statement[] }
    | { kind: 'break'; label?: Label; value?: Expression }
    | { kind: 'continue'; label?: Label; value?: Expression }
    | { kind: 'return'; value?: Expression }
    | { kind: 'structInit'; type?: Expression; fields: FieldInit[] }
    | { kind: 'arrayInit'; type?: Expression; elements: Expression[] }
    | { kind: 'builtinType'; name: string }
    | { kind: 'optionalType'; child: Expression }
    | { kind: 'pointerType'; isConst: boolean; child: Expression }
    | { kind: 'sliceType'; isConst: boolean; sentinel?: Expression; child: Expression }
    | { kind: 'arrayType'; count?: Expression; sentinel?: Expression; child: Expression }
    | { kind: 'errorUnionType'; errorSet: Expression; payload: Expression }
    | { kind: 'errorSetType'; names: string[] }
    | { kind: 'fnType'; params: Parameter[]; returnType: Expression }
    | Container
    | { kind: 'paren'; operand: Expression }
    | { kind: 'assign'; operator: AssignOperator; targets: Expression[]; value: Expression }
  );

export type ExpressionOf<K extends Expression['kind']> = Extract<Expression, { kind: K }>;

export type Block = ExpressionOf<'block'>;

export interface ForOperand extends Span {
  value: Expression;
  /** The end of a range `start..end`, or undefined for an open range `start..` and for other operands. */
  rangeEnd?: Expression;
  isRange: boolean;
}

export interface SwitchItem extends Span {
  value: Expression;
  /** The last value of a range `first...last`. */
  last?: Expression;
}

export interface SwitchCase extends Span {
  /** Empty for `else`. */
  items: SwitchItem[];
  isElse: boolean;
  isInline: boolean;
  capture?: Capture;
  /** The tag of a union's case, as in `|payload, tag|`. */
  tagCapture?: Capture;
  body: Expression;
}

export interface FieldInit extends Span {
  name: string;
  value: Expression;
}

export interface DestructureTarget extends Span {
  /** A declaration such as `const x` or `var y: i32`, or else an expression to assign to. */
  declaration?: { name: string; isConst: boolean; type?: Expression };
  target?: Expression;
}

export type Statement = Span &
  (
    | VariableDeclaration
    | { kind: 'destructure'; targets: DestructureTarget[]; value: Expression }
    | { kind: 'expression'; expression: Expression }
    | { kind: 'defer'; isErrdefer: boolean; body: Expression }
  );

export interface SourceFile {
  functions: FunctionDeclaration[];
  members: ContainerMember[];
  fields: ContainerField[];
}
