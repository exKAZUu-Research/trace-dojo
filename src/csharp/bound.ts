import type { Expression } from './ast';
/** The bound tree: the program after name resolution, overload resolution, and type checking, which the evaluator runs. */
import type { TypeContext } from './binderBase';
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
  /** Whether an `await` inside the expression may suspend it, which then runs as a generator. */
  suspends?: true;
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
  /** The variables its pattern and guard declare, which leave scope with the arm. */
  locals: LocalSymbol[];
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
      /** For a static abstract method called through a type parameter, the parameter whose type argument implements it. */
      constrainedType?: Type;
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
      /** For a static abstract property read through a type parameter, the parameter that implements it. */
      constrainedType?: Type;
      /** For an extension property of a generic extension block, the block's type arguments. */
      typeArgs?: Type[];
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
  | ({
      kind: 'unary';
      operator: string;
      operand: BoundExpression;
      operandKind: OperandKind;
      isLifted: boolean;
      isChecked?: boolean;
    } & Base)
  | ({
      kind: 'binary';
      operator: string;
      left: BoundExpression;
      right: BoundExpression;
      operandKind: OperandKind;
      isLifted: boolean;
      /** Whether integral overflow throws, as in a `checked` context; undefined follows the program's default. */
      isChecked?: boolean;
    } & Base)
  | ({ kind: 'logical'; operator: '&&' | '||'; left: BoundExpression; right: BoundExpression } & Base)
  /**
   * `&&` or `||` on a type with user-defined operators: when `test` (`operator false` or `true`) holds for the left
   * value, that value; otherwise `combine` (`&` or `|`), both reading the left value as a `compoundOperand`.
   */
  | ({ kind: 'userLogical'; left: BoundExpression; test: BoundExpression; combine: BoundExpression } & Base)
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
      /** For a user-defined conversion, the operator's call on the converted operand, read as a `compoundOperand`. */
      userCall?: BoundExpression;
      /** Whether a user-defined conversion is lifted, so that a null operand converts to null without the call. */
      isLifted?: boolean;
      isChecked?: boolean;
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
  /**
   * `await operand`: the operand's awaiter (`getAwaiter`, reading the operand as a `compoundOperand`) is awaited until
   * `isCompleted` holds, then `getResult` (reading the awaiter as a `compoundOperand`) gives the value.
   */
  | ({
      kind: 'await';
      operand: BoundExpression;
      getAwaiter: BoundExpression;
      isCompleted: BoundExpression;
      getResult: BoundExpression;
    } & Base)
  /** `typeof(T)`, the one System.Type object of a type. */
  | ({ kind: 'typeOf'; target: Type } & Base)
  /**
   * An operation on `dynamic` values, which binds when it runs: the syntax names its operands `\0d0`, `\0d1`, ...,
   * which take the types of the values (or the static types of operands that are not `dynamic`), and binds in the
   * context of the code that wrote it.
   */
  | ({
      kind: 'late';
      syntax: Expression;
      /** The operands, of which a `ref` or `out` argument of a call passes its variable. */
      operands: BoundArgument[];
      /** The operand whose null value fails as a receiver does, before binding. */
      receiver: number | undefined;
      /** For a conversion of a `dynamic` value, the type it converts to. */
      target: { type: Type; isExplicit: boolean } | undefined;
      /** Where the operation was written, whose names it sees; a conversion needs none. */
      typeContext: TypeContext | undefined;
      /** Whether the operation may stand as a statement: a call, an assignment, or an increment. */
      isStatement: boolean;
      /** Whether a statement drops the value, which lets a call bind to a method returning `void`. */
      isDiscarded?: boolean;
    } & Base)
  /** A UTF-8 string literal, a `ReadOnlySpan<byte>` over its bytes, which every evaluation shares. */
  | ({ kind: 'utf8'; bytes: readonly number[] } & Base)
  /** `__makeref(x)`, a `TypedReference` to a variable and its type. */
  | ({ kind: 'makeRef'; target: BoundLValue } & Base)
  /** `__reftype(r)`, the `System.Type` of the variable a `TypedReference` refers to, or null for a default one. */
  | ({ kind: 'refType'; operand: BoundExpression } & Base)
  /** `__refvalue(r, T)`, the variable a `TypedReference` refers to, which must be exactly of type T. */
  | ({ kind: 'refValue'; operand: BoundExpression } & Base)
  /** `r = ref x`, which makes a ref local refer to another variable, and is that variable's value. */
  | ({ kind: 'refAssign'; local: LocalSymbol; target: BoundLValue } & Base)
  /** `&x`: a pointer to a variable, decomposed into the storage it lies in and its offset there. */
  | ({ kind: 'addressOf'; target: BoundLValue } & Base)
  /** `*p`, the variable a pointer points to, of the pointer's element type. */
  | ({ kind: 'deref'; pointer: BoundExpression } & Base)
  /** `p + n` or `p - n`, which moves a pointer by n elements of `elementSize` bytes. */
  | ({
      kind: 'pointerArith';
      pointer: BoundExpression;
      offset: BoundExpression;
      elementSize: number;
      isSubtract: boolean;
    } & Base)
  /** `p - q`, the number of elements between two pointers, as a long. */
  | ({ kind: 'pointerDiff'; left: BoundExpression; right: BoundExpression; elementSize: number } & Base)
  /** A comparison of two pointers by the addresses they hold. */
  | ({ kind: 'pointerCompare'; operator: string; left: BoundExpression; right: BoundExpression } & Base)
  /** `stackalloc T[n]`, a new buffer of n elements, with an initializer's values. */
  | ({ kind: 'stackalloc'; elementType: Type; length: BoundExpression; values: BoundExpression[] | undefined } & Base)
  /** A `fixed` statement's array or string, as a pointer to its first element, null for a null or empty one. */
  | ({ kind: 'fixedAddress'; value: BoundExpression; isString: boolean } & Base)
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
   * `x[^i]` or `x[a..b]` through a type's Length or Count: `setup` stores the receiver and the index in hidden `locals`,
   * then `access` reads them; an access that is a variable stays one, so `x[^1] = v` and `x[^1] += v` store through it.
   */
  | ({ kind: 'implicitIndex'; setup: BoundExpression[]; access: BoundExpression; locals: LocalSymbol[] } & Base)
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
  | Extract<
      BoundExpression,
      {
        kind:
          | 'local'
          | 'field'
          | 'staticField'
          | 'element'
          | 'property'
          | 'this'
          | 'implicitIndex'
          | 'call'
          | 'deref'
          | 'refValue';
      }
    >
  | ({ kind: 'discard' } & Base);

export type BoundPattern =
  | { kind: 'constant'; value: BoundExpression; inputType: Type; type: Type }
  | {
      kind: 'list';
      inputType: Type;
      /** The hidden locals that `length`, `element`, and `slice` read: the input, an index, and a slice's ends. */
      list: LocalSymbol;
      index: LocalSymbol;
      start: LocalSymbol;
      end: LocalSymbol;
      length: BoundExpression;
      element: BoundExpression;
      /** The patterns before and after a slice pattern, or all of them when there is none. */
      before: BoundPattern[];
      after: BoundPattern[];
      hasSlice: boolean;
      /** The slice and the pattern it must match, for a slice pattern with a pattern. */
      slice: { value: BoundExpression; pattern: BoundPattern } | undefined;
      local: LocalSymbol | undefined;
    }
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

/** A label that `goto` statements jump to. */
export class LabelSymbol {
  isUsed = false;

  constructor(
    readonly name: string,
    readonly row: number
  ) {}
}

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
  /** Whether a `yield return` inside the statement may suspend it, which then runs as a generator. */
  suspends?: true;
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
      /** `IDisposable.Dispose`, which the loop calls when the enumerator implements IDisposable (C# spec §13.9.5). */
      dispose: MethodSymbol;
      disposable: Type;
    };

export type BoundStatement =
  | BoundBlock
  | ({ kind: 'expression'; expression: BoundExpression } & StatementBase)
  | ({
      kind: 'localDeclaration';
      local: LocalSymbol;
      value: BoundExpression | undefined;
      /** The variable a ref local refers to, which it takes instead of a value. */
      refTarget?: BoundLValue;
    } & StatementBase)
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
  | ({
      kind: 'return';
      value: BoundExpression | undefined;
      /** The variable that a method returning by reference returns. */
      refTarget?: BoundLValue;
    } & StatementBase)
  | ({ kind: 'throw'; value: BoundExpression | undefined } & StatementBase)
  | ({ kind: 'try'; body: BoundBlock; catches: BoundCatch[]; finally: BoundBlock | undefined } & StatementBase)
  | ({ kind: 'labeled'; label: LabelSymbol; statement: BoundStatement } & StatementBase)
  /**
   * A jump to a label, or with `goto case` and `goto default` to a section of the enclosing switch; undefined for a
   * `goto case` whose label the switch lacks, which is reported and jumps nowhere.
   */
  | ({ kind: 'goto'; target: LabelSymbol | BoundSwitchSection | undefined } & StatementBase)
  | ({ kind: 'lock'; value: BoundExpression; body: BoundStatement } & StatementBase)
  | ({ kind: 'yieldReturn'; value: BoundExpression } & StatementBase)
  | ({ kind: 'yieldBreak' } & StatementBase)
  /** Runs its body, then disposes the resource its local holds, if not null, through `IDisposable.Dispose`. */
  | ({
      kind: 'using';
      local: LocalSymbol;
      body: BoundStatement;
      dispose: MethodSymbol;
      disposable: NamedType;
      /** `await using`, which awaits the `ValueTask` of `IAsyncDisposable.DisposeAsync`. */
      isAwait?: true;
    } & StatementBase)
  | ({ kind: 'empty' } & StatementBase);
