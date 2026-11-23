import type { Expression } from './ast';
/** The bound tree: the program after name resolution, overload resolution, and type checking, which the evaluator runs. */
import type { ConversionKind } from './conversions';
import type { ArrayType, FieldSymbol, LocalSymbol, MethodSymbol, NamedType, PropertySymbol, Type } from './types';

/** The kinds of operands that built-in operators work on. */
export type OperandKind =
  | 'int'
  | 'uint'
  | 'long'
  | 'ulong'
  | 'float'
  | 'double'
  | 'decimal'
  | 'bool'
  | 'string'
  | 'object'
  | 'char'
  | 'delegate'
  | 'enum';

interface Base {
  type: Type;
  row: number;
}

export type BoundArgument =
  | BoundExpression
  /** A `ref` or `out` argument, which passes a variable rather than its value. */
  | ({ kind: 'refArgument'; target: BoundLValue; refKind: 'ref' | 'out' } & Base);

/**
 * Arguments in the order of the parameters. Named arguments written in another order carry, in `sourceOrder`, the
 * parameter indices in the order the source writes them, in which C# evaluates them.
 */
export type BoundArguments = BoundArgument[] & { readonly sourceOrder?: readonly number[] };

export interface BoundMemberInit {
  kind: 'memberInit';
  target: BoundLValue;
  value: BoundExpression | undefined;
  /** A nested initializer of the member's own object or collection. */
  nested: BoundInitializerEntry[] | undefined;
}

export type BoundInitializerEntry = BoundMemberInit | { kind: 'collectionAdd'; call: BoundExpression };

export interface LambdaInfo {
  method: MethodSymbol;
  /** The locals of enclosing functions that the lambda reads or writes, which it keeps in cells. */
  captures: LocalSymbol[];
  isStatic: boolean;
}

export interface BoundSwitchArm {
  pattern: BoundPattern;
  guard: BoundExpression | undefined;
  value: BoundExpression;
  row: number;
}

export type BoundExpression =
  | ({
      kind: 'constant';
      value: unknown;
      /** Whether a literal, rather than a computation, wrote the value. */ isLiteral?: boolean;
    } & Base)
  | ({ kind: 'local'; local: LocalSymbol } & Base)
  | ({ kind: 'this' } & Base)
  | ({ kind: 'field'; receiver: BoundExpression; field: FieldSymbol } & Base)
  | ({ kind: 'staticField'; field: FieldSymbol; owner: NamedType } & Base)
  | ({ kind: 'element'; array: BoundExpression; indices: BoundExpression[] } & Base)
  | ({
      kind: 'call';
      method: MethodSymbol;
      receiver: BoundExpression | undefined;
      args: BoundArgument[];
      /** The type arguments of a generic method. */
      typeArgs: Type[];
      /** The type the method belongs to, with its type arguments, for static and generic calls. */
      owner: NamedType | undefined;
      /** Whether the call dispatches on the receiver's runtime type, which `base.M()` does not. */
      isVirtual: boolean;
      /** A constructor's call of another, which `: this(...)` makes, rather than `: base(...)`. */
      isThisInitializer?: boolean;
      /**
       * A call the program does not write, such as the base constructor call of a constructor without `: base(...)`,
       * which traces leave out of the calls in progress as the Java interpreter leaves out its implicit `super()`.
       */
      isImplicit?: boolean;
    } & Base)
  | ({
      kind: 'property';
      receiver: BoundExpression | undefined;
      property: PropertySymbol;
      args: BoundArgument[];
      owner: NamedType;
    } & Base)
  | ({ kind: 'invokeDelegate'; target: BoundExpression; args: BoundArgument[] } & Base)
  | ({
      kind: 'new';
      constructor: MethodSymbol | undefined;
      /** A named type, or a type parameter with the `new()` constraint. */
      objectType: NamedType | Extract<Type, { kind: 'typeParameter' }>;
      args: BoundArgument[];
      initializer: BoundInitializerEntry[] | undefined;
    } & Base)
  | ({
      kind: 'newArray';
      arrayType: ArrayType;
      sizes: BoundExpression[];
      elements: BoundExpression[] | undefined;
    } & Base)
  | ({
      kind: 'newDelegate';
      method: MethodSymbol;
      receiver: BoundExpression | undefined;
      typeArgs: Type[];
      owner: NamedType | undefined;
      isVirtual: boolean;
    } & Base)
  | ({ kind: 'lambda'; lambda: LambdaInfo } & Base)
  | ({ kind: 'unary'; operator: string; operand: BoundExpression; operandKind: OperandKind; isLifted: boolean } & Base)
  | ({
      kind: 'binary';
      operator: string;
      left: BoundExpression;
      right: BoundExpression;
      operandKind: OperandKind;
      isLifted: boolean;
    } & Base)
  | ({ kind: 'logical'; operator: '&&' | '||'; left: BoundExpression; right: BoundExpression } & Base)
  | ({
      kind: 'coalesce';
      left: BoundExpression;
      right: BoundExpression;
      unwrapLeft: boolean;
      /** The conversion of a non-null left value to the result type, reading it as a `compoundOperand`. */
      leftConversion?: BoundExpression;
    } & Base)
  | ({ kind: 'conditional'; condition: BoundExpression; whenTrue: BoundExpression; whenFalse: BoundExpression } & Base)
  | ({
      kind: 'convert';
      operand: BoundExpression;
      conversion: ConversionKind;
      from: Type;
      isExplicit: boolean;
      userMethod?: MethodSymbol;
    } & Base)
  | ({ kind: 'assign'; target: BoundLValue; value: BoundExpression } & Base)
  | ({
      kind: 'compoundAssign';
      target: BoundLValue;
      /** Computes the new value from the target's value, which the evaluator passes as `compoundOperand`. */
      operation: BoundExpression;
    } & Base)
  | ({ kind: 'compoundOperand' } & Base)
  | ({ kind: 'increment'; target: BoundLValue; isPrefix: boolean; operation: BoundExpression } & Base)
  | ({ kind: 'is'; operand: BoundExpression; pattern: BoundPattern } & Base)
  | ({ kind: 'as'; operand: BoundExpression; targetType: Type } & Base)
  | ({ kind: 'switch'; value: BoundExpression; arms: BoundSwitchArm[] } & Base)
  | ({ kind: 'concat'; parts: BoundExpression[] } & Base)
  | ({
      kind: 'interpolated';
      parts: (string | { value: BoundExpression; alignment: number | undefined; format: string | undefined })[];
    } & Base)
  | ({ kind: 'tuple'; elements: BoundExpression[] } & Base)
  | ({
      kind: 'conditionalAccess';
      receiver: BoundExpression;
      access: BoundExpression;
      temporary: LocalSymbol;
      wrapsNullable: boolean;
    } & Base)
  | ({ kind: 'throw'; value: BoundExpression } & Base)
  | ({
      kind: 'with';
      value: BoundExpression;
      clone: MethodSymbol | undefined;
      assignments: BoundMemberInit[];
      temporary: LocalSymbol;
    } & Base)
  /** A type's default value; `failedCall` marks a call whose arguments fit no method, which stands for that call. */
  | ({ kind: 'default'; failedCall?: true } & Base)
  | ({ kind: 'deconstructAssign'; targets: BoundDeconstructTarget; value: BoundExpression } & Base)
  | ({ kind: 'eventAccessor'; target: BoundLValue; isAdd: boolean; value: BoundExpression } & Base)
  | ({ kind: 'sequence'; locals: LocalSymbol[]; sideEffects: BoundExpression[]; value: BoundExpression } & Base)
  /**
   * An expression whose type comes from where it is used: a lambda, a method group, `new()`, a collection expression,
   * `default`, or a switch or conditional expression without a natural type. Converting it to a type binds it.
   */
  | ({ kind: 'unbound'; node: Expression; context: unknown; methodGroup?: unknown } & Base);

/** The targets of a deconstruction, which a tuple or a `Deconstruct` method fills one by one. */
export type BoundDeconstructTarget =
  | { kind: 'single'; target: BoundLValue | undefined; conversion: BoundExpression | undefined }
  | { kind: 'nested'; elements: BoundDeconstructTarget[]; deconstruct: MethodSymbol | undefined; elementTypes: Type[] };

/** An expression that names storage: a variable, a field, an array element, or a property or indexer. */
export type BoundLValue =
  | Extract<BoundExpression, { kind: 'local' | 'field' | 'staticField' | 'element' | 'property' | 'this' }>
  | ({ kind: 'discard' } & Base);

export type BoundPattern =
  | { kind: 'constant'; value: BoundExpression; inputType: Type; type: Type }
  | { kind: 'type'; testType: Type; local: LocalSymbol | undefined; inputType: Type }
  | { kind: 'any'; local: LocalSymbol | undefined; inputType: Type }
  | {
      kind: 'relational';
      operator: '<' | '<=' | '>' | '>=';
      value: BoundExpression;
      operandKind: OperandKind;
      inputType: Type;
    }
  | { kind: 'not'; pattern: BoundPattern; inputType: Type }
  | { kind: 'and' | 'or'; left: BoundPattern; right: BoundPattern; inputType: Type }
  | {
      kind: 'recursive';
      testType: Type | undefined;
      inputType: Type;
      /** The narrowed type that the subpatterns read members of. */
      narrowedType: Type;
      deconstruct: MethodSymbol | undefined;
      /** Whether the positional subpatterns read a tuple's elements. */
      isTuple: boolean;
      /** Whether the positional subpatterns read the elements of an `object` through `ITuple`, if it is a tuple. */
      isITuple?: boolean;
      positional: BoundPattern[];
      properties: { members: (FieldSymbol | PropertySymbol)[]; owners: NamedType[]; pattern: BoundPattern }[];
      local: LocalSymbol | undefined;
    };

/** How a statement records its step in a trace. */
export type StepKind =
  /** It records a step when it completes. */
  | 'step'
  /** It only calls methods or creates objects, whose own steps may already show what it did. */
  | 'callsOnly'
  /** It records no step of its own. */
  | 'none';

interface StatementBase {
  row: number;
  step: StepKind;
}

export interface BoundBlock extends StatementBase {
  kind: 'block';
  statements: BoundStatement[];
  /** The captured locals declared in the block, which get fresh cells whenever the block runs. */
  capturedLocals: LocalSymbol[];
  /** The locals declared in the block, which go out of scope when it ends. */
  locals: LocalSymbol[];
}

export interface BoundCatch {
  type: Type;
  local: LocalSymbol | undefined;
  /** The exception variable and the locals the filter declares, which leave scope with the clause. */
  locals: LocalSymbol[];
  filter: BoundExpression | undefined;
  body: BoundBlock;
  row: number;
}

export interface BoundSwitchSection {
  labels: ({ pattern: BoundPattern; guard: BoundExpression | undefined } | 'default')[];
  statements: BoundStatement[];
  /** The locals its statements and patterns declare, which leave scope with the switch. */
  locals: LocalSymbol[];
  row: number;
}

export type ForeachKind =
  | { kind: 'array'; rank: number }
  | { kind: 'string' }
  | {
      kind: 'enumerator';
      getEnumerator: MethodSymbol;
      moveNext: MethodSymbol;
      current: PropertySymbol;
      enumeratorType: Type;
      receiverIsStruct: boolean;
      dispose: MethodSymbol | undefined;
    };

export type BoundStatement =
  | BoundBlock
  | ({ kind: 'expression'; expression: BoundExpression } & StatementBase)
  | ({ kind: 'localDeclaration'; local: LocalSymbol; value: BoundExpression | undefined } & StatementBase)
  | ({
      kind: 'if';
      condition: BoundExpression;
      consequence: BoundStatement;
      alternative: BoundStatement | undefined;
    } & StatementBase)
  | ({ kind: 'while'; condition: BoundExpression; body: BoundStatement } & StatementBase)
  | ({ kind: 'do'; body: BoundStatement; condition: BoundExpression; conditionRow: number } & StatementBase)
  | ({
      kind: 'for';
      initializers: BoundStatement[];
      condition: BoundExpression | undefined;
      updates: BoundExpression[];
      body: BoundStatement;
      capturedLocals: LocalSymbol[];
      locals: LocalSymbol[];
    } & StatementBase)
  | ({
      kind: 'foreach';
      collection: BoundExpression;
      iteration: ForeachKind;
      /** The iteration variable, or the deconstruction of each element into several. */
      variable: LocalSymbol;
      deconstruction: BoundExpression | undefined;
      locals: LocalSymbol[];
      body: BoundStatement;
      elementConversion: BoundExpression | undefined;
      /** Whether the variable's binding records a step, as it does for values learners answer. */
      bindingStoresAnswer: boolean;
    } & StatementBase)
  | ({
      kind: 'switch';
      value: BoundExpression;
      sections: BoundSwitchSection[];
      temporary: LocalSymbol;
      /** Whether the cases match every value without a `default`, so that no value leaves the switch unmatched. */
      isComplete: boolean;
    } & StatementBase)
  | ({ kind: 'break' } & StatementBase)
  | ({ kind: 'continue' } & StatementBase)
  | ({ kind: 'return'; value: BoundExpression | undefined } & StatementBase)
  | ({ kind: 'throw'; value: BoundExpression | undefined } & StatementBase)
  | ({ kind: 'try'; body: BoundBlock; catches: BoundCatch[]; finally: BoundBlock | undefined } & StatementBase)
  | ({ kind: 'empty' } & StatementBase);
