// code-gauge-allow-file fileNcss 998 -- Expression kinds share the same scope and evaluation rules.
import { CompileError } from '../interpreter/diagnostics';
import { ExecutionBudget, LIMITS } from '../interpreter/limits';
import type {
  Annotation,
  Arguments as ArgumentsSyntax,
  CascadeSelector,
  CollectionElement,
  Expression,
  Pattern,
  Span,
  StringPart,
  SwitchExpressionCase,
  TypeParameter,
  TypeSyntax,
} from './ast';
import type { ClassInfo, FieldMember, Member } from './classes';
import { at, type Compiled, CompilerBase, type Eval, type ResolvedMember, typeName, valueIs } from './compilerBase';
import type { Declaration, ExtensionInfo, GlobalVariable, TopLevelFunction, TypeAlias } from './environment';
import { formatDouble, stringOf } from './format';
import { BoundedStringParts } from './library/boundedStringParts';
import type { Frame } from './runtime';
import { type ConditionFlow, Flow, LocalVar } from './scope';
import { closeInferenceHoles, containsInferenceHole, INFERENCE_HOLE, isInferenceHole } from './typeInference';
import {
  closeTypeVariables,
  coreTypes,
  type DartType,
  DYNAMIC,
  type FunctionType,
  instantiateToBounds,
  type InterfaceType,
  interfaceType,
  isNeverType,
  isNonNullable,
  isNullable,
  isPotentiallyNullable,
  isSubtype,
  makeNullable,
  mentionsTypeParams,
  NEVER,
  nonNullable,
  NULL,
  objectType,
  promotionTarget,
  resolveBound,
  sameType,
  substitute,
  typeParamType,
  upperBound,
} from './types';
import {
  type Arguments,
  type Callable,
  type Cell,
  DartList,
  DartRecord,
  DartTypeValue,
  LateInitializer,
  NO_ARGUMENTS,
  UNASSIGNED,
  UNINITIALIZED,
  type Value,
} from './values';

interface StaticClassTarget {
  kind: 'class';
  cls: ClassInfo;
  typeArgs: DartType[] | undefined;
  alias?: TypeAlias;
  syntax: Extract<TypeSyntax, { kind: 'named' }>;
}

type StaticTarget = StaticClassTarget | { kind: 'prefix'; prefix: string } | { kind: 'extension'; ext: ExtensionInfo };

/** The value a null-aware member access gives when its receiver is null, which the rest of its chain passes on. */
export const SHORTED = Symbol('shorted') as unknown as Value;

type PrimaryExpression = Extract<
  Expression,
  {
    kind:
      | 'int'
      | 'double'
      | 'bool'
      | 'null'
      | 'string'
      | 'symbol'
      | 'list'
      | 'setOrMap'
      | 'record'
      | 'identifier'
      | 'this'
      | 'super'
      | 'parenthesized'
      | 'member'
      | 'index'
      | 'call'
      | 'new';
  }
>;

/** What a name means where it is read. */
export type NameResolution =
  | { kind: 'local'; variable: LocalVar }
  | { kind: 'thisMember'; resolved: ResolvedMember; name: string }
  | { kind: 'staticMember'; member: Member; cls: ClassInfo }
  | { kind: 'extensionMember'; resolved: ResolvedMember; name: string }
  | { kind: 'declaration'; declaration: Declaration }
  | { kind: 'prefix'; prefix: string };

/** The operators whose method `x op= y` calls, by assignment operator. */
const COMPOUND_OPERATORS: Record<string, string> = {
  '+=': '+',
  '-=': '-',
  '*=': '*',
  '/=': '/',
  '~/=': '~/',
  '%=': '%',
  '&=': '&',
  '|=': '|',
  '^=': '^',
  '<<=': '<<',
  '>>=': '>>',
  '>>>=': '>>>',
};

export abstract class ExpressionCompiler extends CompilerBase {
  // Implemented by the subclasses that compile calls, closures, patterns, and declarations.
  abstract compileCall(expression: Extract<Expression, { kind: 'call' }>, context: DartType | undefined): Compiled;
  abstract compileNew(expression: Extract<Expression, { kind: 'new' }>, context: DartType | undefined): Compiled;
  abstract compileFunctionExpression(
    expression: Extract<Expression, { kind: 'function' }>,
    context: DartType | undefined
  ): Compiled;
  abstract compileSwitchExpression(
    subject: Expression,
    cases: SwitchExpressionCase[],
    span: Span,
    context: DartType | undefined
  ): Compiled;
  abstract compilePatternAssignment(pattern: Pattern, value: Expression, span: Span): Compiled;
  abstract compileCollectionElements(
    elements: CollectionElement[],
    kind: 'list' | 'set' | 'map',
    elementContext: DartType | undefined,
    valueContext: DartType | undefined
  ): {
    types: { key: DartType; value?: DartType }[];
    run: (frame: Frame, add: (key: Value, value?: Value) => void) => void;
    isConst: boolean;
    creates: boolean;
  };
  abstract compileMethodCall(
    receiver: Compiled,
    name: string,
    args: ArgumentsSyntax,
    typeArguments: TypeSyntax[] | undefined,
    span: Span,
    context: DartType | undefined,
    nullAware: boolean
  ): Compiled;
  abstract compileConstructorTearoff(type: TypeSyntax, name: string | undefined, span: Span): Compiled;
  abstract compileDotShorthand(
    expression: Extract<Expression, { kind: 'dotShorthand' }>,
    context: DartType | undefined
  ): Compiled;
  abstract constructSymbol(frame: Frame, name: string): Value;
  abstract readGlobal(global: GlobalVariable): Eval;
  abstract tearOffFunction(fn: TopLevelFunction): Eval;

  /** Compiles an expression whose value is used, ending a null-aware chain. */
  compileExpression(expression: Expression, context?: DartType): Compiled {
    const { result: compiled, skipped } = this.compileNullChain(() => this.compileChainPart(expression, context));
    if (!skipped) return compiled;
    const { run } = compiled;
    return {
      ...compiled,
      type: makeNullable(compiled.type),
      variable: undefined,
      run: (frame) => {
        const value = run(frame);
        return value === SHORTED ? undefined : value;
      },
    };
  }

  private nullChain = { exit: undefined as Flow | undefined };

  protected compileNullChain<T>(compile: () => T): { result: T; skipped: Flow | undefined } {
    const outer = this.nullChain;
    const chain: { exit: Flow | undefined } = { exit: undefined };
    this.nullChain = chain;
    try {
      const result = compile();
      const skipped = chain.exit;
      if (skipped) this.flow = Flow.join(this.flow, skipped);
      return { result, skipped };
    } finally {
      this.nullChain = outer;
    }
  }

  protected skipOnNull(receiver: Compiled, nullAware: boolean): void {
    if (!nullAware) return;
    const { whenNull, whenNonNull } = this.nullBranches(receiver);
    const { exit } = this.nullChain;
    this.nullChain.exit = exit ? Flow.join(exit, whenNull) : whenNull;
    this.flow = whenNonNull;
  }

  protected nullBranches(value: Compiled): { whenNull: Flow; whenNonNull: Flow } {
    const before = this.flow;
    if (!isPotentiallyNullable(value.type)) return { whenNull: before.unreachable, whenNonNull: before };
    if (value.type.kind === 'null') return { whenNull: before, whenNonNull: before.unreachable };
    const variable = value.variable;
    const narrowed = promotionTarget(value.type, nonNullable(value.type));
    const whenNonNull =
      variable && narrowed && this.isPromotable(variable) ? before.promote(variable, narrowed) : before;
    return { whenNull: before, whenNonNull };
  }

  /** Compiles a condition, which must be a `bool`, and the flow when it is true and when it is false. */
  compileCondition(expression: Expression): { compiled: Compiled; flow: ConditionFlow } {
    const { compiled, flow } = this.compileConditionInner(expression);
    return { compiled: this.requireBool(compiled, expression), flow };
  }

  protected requireBool(compiled: Compiled, span: Span): Compiled {
    const type = interfaceType(coreTypes.bool);
    if (compiled.type.kind === 'dynamic')
      return { ...compiled, type, run: this.runtimeCast(compiled.run, type, false) };
    if (!isSubtype(compiled.type, type)) {
      this.error(span, `条件には bool 型の値が必要ですが、${typeName(compiled.type)} 型の値が書かれています。`);
    }
    return compiled;
  }

  // code-gauge-allow functionCognitiveComplexity 18 -- One case per kind of condition that tells flow analysis something.
  // code-gauge-allow functionNcss 37 -- One case per kind of condition that tells flow analysis something.
  protected compileConditionInner(expression: Expression): { compiled: Compiled; flow: ConditionFlow } {
    switch (expression.kind) {
      case 'parenthesized': {
        return this.compileConditionInner(expression.expression);
      }
      case 'identifier': {
        const resolution = this.resolveName(expression.name);
        if (resolution?.kind !== 'local') break;
        const compiled = this.compileExpression(expression);
        const stored = this.flow.conditionFlowFor(resolution.variable, (local) => this.isPromotable(local));
        return {
          compiled,
          flow: stored ?? { whenTrue: this.flow, whenFalse: this.flow },
        };
      }
      case 'bool': {
        const compiled = this.compileExpression(expression);
        return {
          compiled,
          flow: expression.value
            ? { whenTrue: this.flow, whenFalse: this.flow.unreachable }
            : { whenTrue: this.flow.unreachable, whenFalse: this.flow },
        };
      }
      case 'prefix': {
        if (expression.operator !== '!') break;
        const inner = this.compileConditionInner(expression.operand);
        const { run } = this.requireBool(inner.compiled, expression.operand);
        return {
          compiled: {
            type: interfaceType(coreTypes.bool),
            run: (frame) => !(run(frame) as boolean),
            isConst: inner.compiled.isConst,
            constValue: inner.compiled.constValue ? { value: !inner.compiled.constValue.value } : undefined,
          },
          flow: { whenTrue: inner.flow.whenFalse, whenFalse: inner.flow.whenTrue },
        };
      }
      case 'binary': {
        if (expression.operator === '&&' || expression.operator === '||') return this.compileLogical(expression);
        if (expression.operator === '==' || expression.operator === '!=') {
          const result = this.compileEquality(expression);
          return result;
        }
        break;
      }
      case 'is': {
        return this.compileIs(expression);
      }
      default: {
        break;
      }
    }
    const compiled = this.compileExpression(expression);
    return { compiled, flow: { whenTrue: this.flow, whenFalse: this.flow } };
  }

  protected compileLogical(expression: Extract<Expression, { kind: 'binary' }>): {
    compiled: Compiled;
    flow: ConditionFlow;
  } {
    const isAnd = expression.operator === '&&';
    const left = this.compileConditionInner(expression.left);
    const leftRun = this.requireBool(left.compiled, expression.left).run;
    this.flow = isAnd ? left.flow.whenTrue : left.flow.whenFalse;
    const right = this.compileConditionInner(expression.right);
    const rightRun = this.requireBool(right.compiled, expression.right).run;
    const flow: ConditionFlow = isAnd
      ? { whenTrue: right.flow.whenTrue, whenFalse: Flow.join(left.flow.whenFalse, right.flow.whenFalse) }
      : { whenTrue: Flow.join(left.flow.whenTrue, right.flow.whenTrue), whenFalse: right.flow.whenFalse };
    this.flow = Flow.join(flow.whenTrue, flow.whenFalse);
    const isConst = left.compiled.isConst && right.compiled.isConst;
    return {
      compiled: {
        type: interfaceType(coreTypes.bool),
        run: isAnd
          ? (frame) => (leftRun(frame) as boolean) && (rightRun(frame) as boolean)
          : (frame) => (leftRun(frame) as boolean) || (rightRun(frame) as boolean),
        isConst,
        constValue:
          left.compiled.constValue && right.compiled.constValue
            ? {
                value: isAnd
                  ? (left.compiled.constValue.value as boolean) && (right.compiled.constValue.value as boolean)
                  : (left.compiled.constValue.value as boolean) || (right.compiled.constValue.value as boolean),
              }
            : undefined,
      },
      flow,
    };
  }

  /** `super == other`, which calls the superclass's `==`. */
  protected abstract compileSuperEquality(expression: Extract<Expression, { kind: 'binary' }>): Compiled;

  // code-gauge-allow functionCognitiveComplexity 19 -- Equality evaluates both operands in order and promotes only stable paths.
  protected compileEquality(expression: Extract<Expression, { kind: 'binary' }>): {
    compiled: Compiled;
    flow: ConditionFlow;
  } {
    if (expression.left.kind === 'super') {
      return { compiled: this.compileSuperEquality(expression), flow: { whenTrue: this.flow, whenFalse: this.flow } };
    }
    const left = this.compileExpression(expression.left);
    const outerWrites = this.flow.writes;
    if (left.variable) this.flow = this.flow.withWrites(new Set());
    // The right operand of == takes the left's type as its context, which `c == .red` needs.
    const right = this.compileExpression(
      expression.right,
      expression.right.kind === 'dotShorthand' ? nonNullable(left.type) : undefined
    );
    const leftVariable = left.variable && !this.flow.wrotePath(left.variable) ? left.variable : undefined;
    if (left.variable) this.flow = this.flow.restoreWrites(outerWrites);
    for (const [operand, syntax] of [
      [left, expression.left],
      [right, expression.right],
    ] as const) {
      if (operand.type.kind === 'void') this.error(syntax, 'void の値は、式の中では使えません。');
    }
    const negated = expression.operator === '!=';
    const nullVariable =
      right.type.kind === 'null' && leftVariable
        ? leftVariable
        : left.type.kind === 'null' && right.variable
          ? right.variable
          : undefined;
    let whenEqual = this.flow;
    let whenNotEqual = this.flow;
    if (nullVariable && this.isPromotable(nullVariable)) {
      const current = this.promotedType(nullVariable);
      const nonNull = nonNullable(current);
      if (!sameType(nonNull, current)) whenNotEqual = this.flow.promote(nullVariable, nonNull);
    }
    const compiled = this.equalityOf(left, right, negated, expression);
    return {
      compiled,
      flow: negated
        ? { whenTrue: whenNotEqual, whenFalse: whenEqual }
        : { whenTrue: whenEqual, whenFalse: whenNotEqual },
    };
  }

  protected equalityOf(left: Compiled, right: Compiled, negated: boolean, span: Span): Compiled {
    const equals = this.lookupMember(nonNullable(left.type), '==', false);
    const parameter = equals?.member.kind === 'method' ? (equals.type as FunctionType).positional[0] : undefined;
    if (parameter)
      right = this.coerce(
        right,
        makeNullable(parameter),
        span,
        (from, to) => `${from} 型の値は、== の右辺 ${to} に合いません。`
      );
    const leftRun = left.run;
    const rightRun = right.run;
    const constValue =
      left.constValue && right.constValue && isPrimitive(left.constValue.value) && isPrimitive(right.constValue.value)
        ? { value: primitiveEquals(left.constValue.value, right.constValue.value) !== negated }
        : undefined;
    return {
      type: interfaceType(coreTypes.bool),
      run: (frame) => {
        const a = leftRun(frame);
        frame.temporaries.push(a);
        let b: Value;
        try {
          b = rightRun(frame);
        } finally {
          frame.temporaries.pop();
        }
        return frame.runtime.equals(a, b) !== negated;
      },
      isConst: left.isConst && right.isConst,
      constValue,
    };
  }

  private compileIs(expression: Extract<Expression, { kind: 'is' }>): { compiled: Compiled; flow: ConditionFlow } {
    const value = this.compileExpression(expression.value);
    if (value.type.kind === 'void') this.error(expression.value, 'void の値は、式の中では使えません。');
    const type = this.resolveType(expression.type);
    const resolve = this.runtimeType(type);
    const { run } = value;
    const { variable } = value;
    const tested = variable ? this.flow.rememberTypeTest(variable, type) : this.flow;
    let promoted = tested;
    if (variable && this.isPromotable(variable)) {
      const current = this.promotedType(variable);
      const narrowed = promotionTarget(current, type);
      if (narrowed) promoted = tested.promote(variable, narrowed);
    }
    const { negated } = expression;
    return {
      compiled: {
        type: interfaceType(coreTypes.bool),
        run: (frame) => {
          const result = this.valueIsAt(frame, run(frame), resolve(frame));
          return result !== negated;
        },
        isConst: value.isConst && !this.usesLexicalTypeVariables(type),
      },
      flow: negated ? { whenTrue: tested, whenFalse: promoted } : { whenTrue: promoted, whenFalse: tested },
    };
  }

  protected valueIsAt(frame: Frame, value: Value, type: DartType): boolean {
    return valueIs(frame.runtime, value, type);
  }

  protected compileChainPart(expression: Expression, context: DartType | undefined): Compiled {
    const explicitlyConst = 'isConst' in expression && expression.isConst;
    const params =
      this.inConstContext || explicitlyConst
        ? new Set(this.typeScopes.flatMap(({ names, staticOwner }) => (staticOwner ? [] : [...names.values()])))
        : undefined;
    const closed =
      params?.size && context && mentionsTypeParams(context, params) ? closeTypeVariables(context, params) : context;
    const compiled = this.compileChainNode(expression, closed);
    if (isNeverType(compiled.type)) this.flow = this.flow.unreachable;
    if (params?.size && compiled.isConst && mentionsTypeParams(compiled.type, params))
      this.error(expression, '定数の型引数には、型変数を使えません。');
    if (!this.inConstContext && explicitlyConst) this.checkConstant(expression, compiled);
    return compiled;
  }

  // code-gauge-allow functionNcss 38 -- One case per form of the construct, which reads best together.
  private compileChainNode(expression: Expression, context: DartType | undefined): Compiled {
    switch (expression.kind) {
      case 'assign': {
        return this.compileAssignment(expression);
      }
      case 'patternAssign': {
        return this.compilePatternAssignment(expression.pattern, expression.value, expression);
      }
      case 'prefix': {
        return this.compilePrefix(expression, context);
      }
      case 'postfix': {
        return this.compileIncrement(expression.operand, expression.operator === '++' ? '+' : '-', false, expression);
      }
      case 'nullAssert': {
        return this.compileNullAssert(expression);
      }
      case 'binary': {
        return this.compileBinary(expression, context);
      }
      case 'conditional': {
        return this.compileConditional(expression, context);
      }
      case 'is': {
        return this.compileIs(expression).compiled;
      }
      case 'as': {
        return this.compileAs(expression);
      }
      case 'throw': {
        return this.compileThrow(expression);
      }
      case 'function': {
        return this.compileFunctionExpression(expression, context);
      }
      case 'cascade': {
        return this.compileCascade(expression, context);
      }
      case 'switch': {
        return this.compileSwitchExpression(expression.subject, expression.cases, expression, context);
      }
      case 'dotShorthand': {
        return this.compileDotShorthand(expression, context);
      }
      case 'instantiation': {
        return this.compileInstantiation(expression);
      }
      case 'constructorTearoff': {
        return this.compileConstructorTearoff(expression.type, expression.name, expression);
      }
      case 'await': {
        return this.unsupported(expression, 'await（非同期処理）');
      }
      default: {
        return this.compilePrimary(expression, context);
      }
    }
  }

  /** Literals, names, and the selectors of member access, indexing, calls, and creation. */
  // code-gauge-allow functionNcss 40 -- One case per form of the construct, which reads best together.
  private compilePrimary(expression: PrimaryExpression, context: DartType | undefined): Compiled {
    switch (expression.kind) {
      case 'int': {
        return this.compileInt(expression, context, false);
      }
      case 'double': {
        const { value } = expression;
        return { type: interfaceType(coreTypes.double), run: () => value, isConst: true, constValue: { value } };
      }
      case 'bool': {
        const { value } = expression;
        return { type: interfaceType(coreTypes.bool), run: () => value, isConst: true, constValue: { value } };
      }
      case 'null': {
        return { type: NULL, run: () => {}, isConst: true, constValue: { value: undefined } };
      }
      case 'string': {
        return this.compileString(expression.parts);
      }
      case 'symbol': {
        const { name } = expression;
        return {
          type: interfaceType(coreTypes.symbol),
          run: this.canonicalized((frame) => this.constructSymbol(frame, name)),
          isConst: true,
        };
      }
      case 'list': {
        return this.compileListLiteral(expression, context);
      }
      case 'setOrMap': {
        return this.compileSetOrMapLiteral(expression, context);
      }
      case 'record': {
        return this.compileRecordLiteral(expression, context);
      }
      case 'identifier': {
        return this.compileIdentifier(expression);
      }
      case 'this': {
        return this.compileThis(expression);
      }
      case 'super': {
        return this.error(expression, 'super はメンバーの呼び出しにしか使えません。');
      }
      case 'parenthesized': {
        const inner = this.compileExpression(expression.expression, context);
        return { ...inner, variable: inner.variable };
      }
      case 'member': {
        return this.compileMember(expression);
      }
      case 'index': {
        return this.compileIndex(expression);
      }
      case 'call': {
        return this.compileCall(expression, context);
      }
      case 'new': {
        return this.compileNew(expression, context);
      }
    }
  }

  // Literals

  // code-gauge-allow functionCognitiveComplexity 18 -- Apply the distinct literal ranges and exact double conversion.
  protected compileInt(
    expression: Extract<Expression, { kind: 'int' }>,
    context: DartType | undefined,
    negated: boolean
  ): Compiled {
    const exact = negated ? -expression.value : expression.value;
    if (context && isDoubleContext(context)) {
      // Negating the converted magnitude keeps `-0` negative, which a bigint cannot.
      const magnitude = Number(expression.value);
      const value = negated ? -magnitude : magnitude;
      if (!Number.isFinite(value) || BigInt(value) !== exact) {
        this.error(expression, `整数リテラル ${expression.text} は、double として正確に表せません。`);
      }
      return { type: interfaceType(coreTypes.double), run: () => value, isConst: true, constValue: { value } };
    }
    const isHex = /^0[xX]/.test(expression.text);
    const limit = isHex && !negated ? 1n << 64n : negated ? 1n << 63n : (1n << 63n) - 1n;
    if ((negated ? -exact : exact) > (isHex && !negated ? limit - 1n : limit)) {
      this.error(expression, `整数リテラル ${negated ? '-' : ''}${expression.text} は、64 ビットの int で表せません。`);
    }
    const value = BigInt.asIntN(64, exact);
    return { type: interfaceType(coreTypes.int), run: () => value, isConst: true, constValue: { value } };
  }

  private compileString(parts: StringPart[]): Compiled {
    const pieces: (string | Eval)[] = [];
    let isConst = true;
    for (const part of parts) {
      if (typeof part === 'string') {
        pieces.push(part);
        continue;
      }
      const compiled = this.compileExpression(part);
      if (compiled.type.kind === 'void') this.error(part, 'void の値は文字列に埋め込めません。');
      isConst &&= compiled.isConst;
      const constant = compiled.constValue?.value;
      if (compiled.isConst && compiled.constValue && isPrimitive(constant)) {
        pieces.push(primitiveText(constant));
      } else pieces.push(compiled.run);
    }
    const type = interfaceType(coreTypes.string);
    const constText = pieces.every((piece) => typeof piece === 'string') ? this.foldConstantString(pieces) : undefined;
    if (constText !== undefined) {
      return { type, run: () => constText, isConst: true, constValue: { value: constText } };
    }
    return { type, run: (frame) => interpolateString(frame, pieces, isConst), isConst };
  }

  private constantStringBudget: ExecutionBudget | undefined;

  protected foldConstantString(parts: readonly string[]): string | undefined {
    const length = parts.reduce((total, part) => total + part.length, 0);
    if (length > LIMITS.maxStringLength) return undefined;
    const budget = (this.constantStringBudget ??= new ExecutionBudget());
    // Folded results stay reachable throughout compilation, which needs a tighter aggregate bound than runtime work.
    budget.spend(Math.max(1, Math.ceil(length / 8)));
    return parts.join('');
  }

  private compileListLiteral(
    expression: Extract<Expression, { kind: 'list' }>,
    context: DartType | undefined
  ): Compiled {
    let elementType: DartType | undefined;
    if (expression.typeArguments) {
      if (expression.typeArguments.length !== 1) this.error(expression, 'リストのリテラルの型引数は 1 つです。');
      elementType = this.resolveType(expression.typeArguments[0]);
    }
    const contextElement = elementType ?? elementTypeOfContext(context, coreTypes.list);
    const elements = this.withConstContext(expression.isConst, () =>
      this.compileCollectionElements(expression.elements, 'list', contextElement, undefined)
    );
    if (expression.isConst && !elements.isConst)
      this.error(expression, 'const のリストの要素は、定数でなければなりません。');
    elementType ??= literalTypeArgument(
      contextElement,
      elements.types.map((type) => type.key)
    );
    const type = interfaceType(coreTypes.list, [elementType]);
    const resolve = this.runtimeType(elementType);
    // Inside a constant context, a literal without `const` is constant too.
    const isConst = expression.isConst || (this.inConstContext && elements.isConst);
    const build: Eval = (frame) => {
      const list = new DartList(coreTypes.list, resolve(frame), [], !isConst, isConst);
      // The elements built so far stay reachable while later ones are evaluated.
      frame.temporaries.push(list);
      try {
        elements.run(frame, (value) => {
          list.elements.push(value);
        });
      } finally {
        frame.temporaries.pop();
      }
      frame.runtime.allocate(list.elements.length);
      return list;
    };
    return { type, run: isConst ? this.canonicalized(build) : build, isConst, creates: elements.creates };
  }

  // code-gauge-allow functionCognitiveComplexity 20 -- Each branch is one of the cases Dart distinguishes for this construct.
  private compileSetOrMapLiteral(
    expression: Extract<Expression, { kind: 'setOrMap' }>,
    context: DartType | undefined
  ): Compiled {
    const { typeArguments, elements: syntax } = expression;
    let kind: 'set' | 'map' | undefined;
    if (typeArguments?.length === 1) kind = 'set';
    else if (typeArguments?.length === 2) kind = 'map';
    else if (typeArguments) this.error(expression, 'セットやマップのリテラルの型引数は、1 つか 2 つです。');
    // Empty braces that nothing decides make a map; other elements that do not tell, such as dynamic spreads, need a type.
    kind ??= this.setOrMapFromElements(syntax, context) ?? (syntax.length === 0 ? 'map' : undefined);
    if (!kind) {
      // Spreads whose types depend on loop bindings or promotions decide only once compiled in their scopes, so the
      // literal is the one kind it compiles as.
      const fits = (['set', 'map'] as const).filter((candidate) => this.compilesAs(expression, candidate));
      if (fits.length !== 1)
        return this.error(syntax[0], 'セットかマップかを決められません。型引数か、変数の型を書いてください。');
      return this.compileSetOrMapLiteral(expression, unresolvedCollectionType(fits[0]));
    }
    const types = typeArguments?.map((argument) => this.resolveType(argument));
    if (kind === 'set') {
      const contextElement = types?.[0] ?? elementTypeOfContext(context, coreTypes.set);
      const compiled = this.withConstContext(expression.isConst, () =>
        this.compileCollectionElements(syntax, 'set', contextElement, undefined)
      );
      if (expression.isConst && !compiled.isConst)
        this.error(expression, 'const のセットの要素は、定数でなければなりません。');
      const elementType =
        types?.[0] ??
        literalTypeArgument(
          contextElement,
          compiled.types.map((type) => type.key)
        );
      return this.buildSet(
        interfaceType(coreTypes.set, [elementType]),
        compiled.run,
        expression.isConst || (this.inConstContext && compiled.isConst)
      );
    }
    const contextMap = mapTypesOfContext(context);
    const keyContext = types?.[0] ?? contextMap?.[0];
    const valueContext = types?.[1] ?? contextMap?.[1];
    const compiled = this.withConstContext(expression.isConst, () =>
      this.compileCollectionElements(syntax, 'map', keyContext, valueContext)
    );
    if (expression.isConst && !compiled.isConst)
      this.error(expression, 'const のマップの要素は、定数でなければなりません。');
    const keyType =
      types?.[0] ??
      literalTypeArgument(
        keyContext,
        compiled.types.map((type) => type.key)
      );
    const valueType =
      types?.[1] ??
      literalTypeArgument(
        valueContext,
        compiled.types.map((type) => type.value ?? DYNAMIC)
      );
    return this.buildMap(
      interfaceType(coreTypes.map, [keyType, valueType]),
      compiled.run,
      expression.isConst || (this.inConstContext && compiled.isConst)
    );
  }

  /**
   * Whether braces without type arguments make a set or a map, as the Dart specification disambiguates them: by the
   * context first, then by the elements; undefined when neither tells, so that a nested literal waits for the context
   * it is compiled in.
   */
  private setOrMapFromElements(
    elements: CollectionElement[],
    context: DartType | undefined
  ): 'set' | 'map' | undefined {
    const base = context && resolveBound(context);
    if (base?.kind === 'interface') {
      if (base.cls.isSubclassOf(coreTypes.map)) return 'map';
      if (base.cls.isSubclassOf(coreTypes.set) || base.cls === coreTypes.iterable) return 'set';
    }
    // Elements other than spreads decide first; only without them do the spreads' types decide.
    const kindsOf = (spreads: boolean): Set<'set' | 'map'> =>
      new Set(elements.map((element) => this.elementKind(element, spreads)).filter((kind) => kind !== undefined));
    let kinds = kindsOf(false);
    if (kinds.size === 0) kinds = kindsOf(true);
    if (kinds.size === 2)
      this.error(elements[0], 'セットの要素とマップの要素を、1 つのリテラルに混ぜることはできません。');
    const [kind] = kinds;
    return kind;
  }

  private elementKind(element: CollectionElement, spreads: boolean): 'set' | 'map' | undefined {
    switch (element.kind) {
      case 'mapEntry': {
        return 'map';
      }
      case 'spread': {
        return spreads ? this.spreadKind(element.value) : undefined;
      }
      case 'ifElement': {
        return (
          this.elementKind(element.consequent, spreads) ??
          (element.alternative ? this.elementKind(element.alternative, spreads) : undefined)
        );
      }
      case 'forElement':
      case 'forInElement': {
        return this.elementKind(element.body, spreads);
      }
      case 'nullAwareElement': {
        return 'set';
      }
      default: {
        return 'set';
      }
    }
  }

  /** Whether braces compile as the kind, compiling them without keeping their code, flow, or errors. */
  private compilesAs(expression: Extract<Expression, { kind: 'setOrMap' }>, kind: 'set' | 'map'): boolean {
    const savedFlow = this.flow;
    try {
      this.compileSetOrMapLiteral(expression, unresolvedCollectionType(kind));
      return true;
    } catch (error) {
      if (!(error instanceof CompileError)) throw error;
      return false;
    } finally {
      this.flow = savedFlow;
    }
  }

  /** Whether a spread names a map or another iterable, read from the static type of its value. */
  private spreadKind(value: Expression): 'set' | 'map' | undefined {
    if (value.kind === 'list') return 'set';
    if (value.kind === 'setOrMap') {
      if (value.typeArguments) return value.typeArguments.length === 2 ? 'map' : 'set';
      // Reached only when the enclosing literal's context did not decide, so a nested literal decides as it would alone.
      return this.setOrMapFromElements(value.elements, undefined) ?? (value.elements.length === 0 ? 'map' : undefined);
    }
    const type =
      (value.kind === 'identifier' ? this.declaredTypeOf(value.name) : undefined) ?? this.speculativeTypeOf(value);
    if (!type) return undefined;
    const base = resolveBound(nonNullable(type));
    if (base.kind !== 'interface') return undefined;
    if (base.cls.isSubclassOf(coreTypes.map)) return 'map';
    if (base.cls.isSubclassOf(coreTypes.iterable)) return 'set';
    return undefined;
  }

  private declaredTypeOf(name: string): DartType | undefined {
    const resolution = this.resolveName(name);
    if (resolution?.kind === 'local') return this.promotedType(resolution.variable);
    if (resolution?.kind === 'declaration' && resolution.declaration.kind === 'variable')
      return resolution.declaration.global.type;
    return undefined;
  }

  /** An expression's static type, compiling it without keeping its code, flow, or errors. */
  private speculativeTypeOf(value: Expression): DartType | undefined {
    const savedFlow = this.flow;
    try {
      return this.compileExpression(value).type;
    } catch (error) {
      if (!(error instanceof CompileError)) throw error;
      return undefined;
    } finally {
      this.flow = savedFlow;
    }
  }

  protected abstract buildSet(
    type: DartType,
    run: (frame: Frame, add: (key: Value) => void) => void,
    isConst: boolean
  ): Compiled;
  protected abstract buildMap(
    type: DartType,
    run: (frame: Frame, add: (key: Value, value?: Value) => void) => void,
    isConst: boolean
  ): Compiled;

  // code-gauge-allow functionCognitiveComplexity 29 -- Compile fields in source order and keep named fields sorted in the type and value.
  private compileRecordLiteral(
    expression: Extract<Expression, { kind: 'record' }>,
    context: DartType | undefined
  ): Compiled {
    const base = context ? resolveBound(context) : undefined;
    const recordContext = base?.kind === 'record' ? base : undefined;
    const positionalCount = expression.fields.filter(({ name }) => name === undefined).length;
    const positionalContext =
      recordContext?.positional.length === positionalCount ? recordContext.positional : undefined;
    const names = new Set<string>();
    let position = 0;
    const fields = this.withConstContext(expression.isConst, () =>
      expression.fields.map((field) => {
        const { name, value } = field;
        if (name !== undefined) this.checkRecordFieldName(name, field, names, positionalCount);
        const expected =
          name === undefined
            ? positionalContext?.[position++]
            : recordContext?.named.find((other) => other.name === name)?.type;
        const written = this.compileExpression(value, expected);
        // A generic function in a field takes the type arguments its context asks for, as a record cannot be instantiated.
        const compiled =
          (expected && this.instantiateGeneric(written, expected, containsInferenceHole(expected))) ?? written;
        if (compiled.type.kind === 'void') this.error(field, 'void の値はレコードに入れられません。');
        return { name, compiled };
      })
    );
    const type: DartType = {
      kind: 'record',
      positional: fields.flatMap(({ name, compiled }) => (name === undefined ? [compiled.type] : [])),
      named: fields
        .flatMap(({ name, compiled }) => (name === undefined ? [] : [{ name, type: compiled.type }]))
        .toSorted((a, b) => (a.name < b.name ? -1 : 1)),
      nullable: false,
    };
    const allConstant = fields.every(({ compiled }) => compiled.isConst);
    if (expression.isConst && !allConstant) {
      this.error(expression, 'const のレコードのフィールドは、定数でなければなりません。');
    }
    const isConst = expression.isConst || (allConstant && (this.inConstContext || this.inParameterDefault));
    const namesKey = this.registerRecordFieldNames(type.named);
    const build = recordLiteralBuilder(fields, type.named, namesKey);
    return {
      type,
      run: isConst ? this.canonicalized(build) : build,
      isConst: isConst || (allConstant && this.potentialConstInitializer),
    };
  }

  readonly constantChecks: { span: Span; run: Eval }[] = [];

  protected checkTypeParameterAnnotations(parameters: readonly TypeParameter[]): void {
    for (const parameter of parameters) this.checkAnnotations(parameter.annotations);
  }

  protected abstract checkAnnotations(annotations: Annotation[] | undefined): void;

  protected checkConstant(span: Span, compiled: Compiled): void {
    if (!this.isLibraryCode && compiled.isConst && !compiled.constValue) {
      this.constantChecks.push({ span, run: compiled.run });
    }
  }

  protected potentialConstInitializer = false;
  protected inParameterDefault = false;

  /** Whether the expression being compiled is in a constant context (`const` literals and constructors). */
  protected inConstContext = false;

  protected withConstContext<T>(isConst: boolean, run: () => T): T {
    if (!isConst) return run();
    const previous = this.inConstContext;
    this.inConstContext = true;
    try {
      return run();
    } finally {
      this.inConstContext = previous;
    }
  }

  /** Evaluates a constant once per run and canonicalizes it, so that equal constants are identical. */
  protected abstract canonicalized(build: Eval): Eval;

  // Names

  /** What a name means: a local, a member of the enclosing class or extension, or a top-level declaration. */
  // code-gauge-allow functionCognitiveComplexity 29 -- Lookup order depends on lexical scope and the enclosing declaration.
  // code-gauge-allow functionNcss 40 -- The lookup cases read in scope order.
  resolveName(name: string, span?: Span): NameResolution | undefined {
    const local = this.findLocal(name, span);
    if (local) return { kind: 'local', variable: local };
    if (span) this.findTypeParam(name, span);
    const cls = this.currentClass;
    if (cls) {
      const own = cls.members.get(name) ?? cls.setters.get(name);
      if (own && !own.isStatic) {
        const resolved = this.lookupMember(cls.thisType, name, cls.members.get(name) === undefined);
        if (resolved) return { kind: 'thisMember', resolved, name };
      }
      const staticMember = cls.staticMembers.get(name) ?? cls.staticSetters.get(name);
      if (staticMember) return { kind: 'staticMember', member: staticMember, cls };
    }
    const ext = this.currentExtension;
    if (ext) {
      const own = ext.members.get(name) ?? ext.setters.get(name);
      if (own) {
        const resolved = this.lookupMember(ext.onType, name, ext.members.get(name) === undefined);
        if (resolved) return { kind: 'extensionMember', resolved, name };
      }
      const staticMember = ext.staticMembers.get(name) ?? ext.staticSetters.get(name);
      if (staticMember) return { kind: 'staticMember', member: staticMember, cls: staticMember.owner };
    }
    const declaration = this.library.lookup(name);
    if (declaration) return { kind: 'declaration', declaration };
    if (this.library.hasPrefix(name)) return { kind: 'prefix', prefix: name };
    if (cls && this.fn.kind.hasThis) {
      const resolved = this.lookupMember(cls.thisType, name, false) ?? this.lookupMember(cls.thisType, name, true);
      if (resolved && !resolved.member.isStatic) return { kind: 'thisMember', resolved, name };
    }
    if (ext) {
      const resolved = this.lookupMember(ext.onType, name, false);
      if (resolved) return { kind: 'extensionMember', resolved, name };
    }
    return undefined;
  }

  protected compileIdentifier(expression: Extract<Expression, { kind: 'identifier' }>): Compiled {
    const { name } = expression;
    if (name === '_') return this.error(expression, '_ は値として使えません。');
    const resolution = this.resolveName(name, expression);
    if (!resolution) {
      // A type parameter is a value of type Type, its type argument at runtime.
      const param = this.findTypeParam(name, expression);
      if (param) {
        const resolve = this.runtimeType(typeParamType(param));
        return {
          type: interfaceType(coreTypes.type),
          run: (frame) => new DartTypeValue(coreTypes.type, resolve(frame)),
          isConst: false,
        };
      }
      if (name === 'dynamic' || name === 'Never') {
        const type = name === 'dynamic' ? DYNAMIC : NEVER;
        return {
          type: interfaceType(coreTypes.type),
          run: () => new DartTypeValue(coreTypes.type, type),
          isConst: true,
        };
      }
      return this.undefinedName(expression, name);
    }
    switch (resolution.kind) {
      case 'local': {
        return this.readLocal(resolution.variable, expression);
      }
      case 'thisMember':
      case 'extensionMember': {
        this.requireThis(expression, name);
        const receiver = this.thisReceiver(expression);
        const compiled = this.readMember(receiver, resolution.resolved, name, expression, false);
        return resolution.kind === 'thisMember'
          ? this.promotableField(compiled, resolution.resolved.member, receiver)
          : compiled;
      }
      case 'staticMember': {
        return this.readStatic(resolution.member, expression);
      }
      case 'declaration': {
        return this.readDeclaration(resolution.declaration, expression);
      }
      case 'prefix': {
        return this.error(expression, `ライブラリの接頭辞 ${name} は、それだけでは値として使えません。`);
      }
    }
  }

  protected readDeclaration(declaration: Declaration, span: Span): Compiled {
    switch (declaration.kind) {
      case 'variable': {
        const { global } = declaration;
        const constant = global.initialValue && global.isConst ? global.initialValue : undefined;
        return { type: global.type, run: this.readGlobal(global), isConst: global.isConst, constValue: constant };
      }
      case 'function': {
        return { type: declaration.fn.type, run: this.tearOffFunction(declaration.fn), isConst: true };
      }
      case 'accessor': {
        const { getter } = declaration;
        if (!getter)
          return this.error(span, `${declaration.setter?.name ?? ''} には getter がないので、値を読めません。`);
        return {
          type: getter.type.returnType,
          run: (frame) =>
            (getter.impl as NonNullable<typeof getter.impl>)(
              frame.runtime,
              undefined,
              { positional: [], named: undefined },
              [],
              span.row
            ),
          isConst: false,
        };
      }
      case 'class': {
        return this.typeLiteralValue(interfaceType(declaration.cls, instantiateToBounds(declaration.cls.typeParams)));
      }
      case 'alias': {
        const { alias } = declaration;
        const args = instantiateToBounds(alias.typeParams);
        const map = new Map(alias.typeParams.map((param, index) => [param, args[index]]));
        return this.typeLiteralValue(substitute(this.resolveAlias(alias, span), map));
      }
      case 'extension': {
        return this.error(span, `拡張 ${declaration.ext.name ?? ''} は値として使えません。`);
      }
    }
  }

  protected readLocal(variable: LocalVar, span: Span): Compiled {
    this.checkDefinitelyAssigned(variable, span);
    if (variable.hasConstant) {
      const value = variable.constant;
      return { type: variable.type, run: () => value, isConst: true, constValue: { value }, variable };
    }
    if (this.inConstContext && variable.constantInitializer)
      return { type: variable.type, run: variable.constantInitializer, isConst: true, variable };
    const cell = this.cellAccess(variable);
    const type = this.isPromotable(variable) ? this.promotedType(variable) : variable.type;
    const { name } = variable;
    const mayBeUnassigned = !variable.options.hasInitializer && !variable.options.isParameter;
    const run: Eval =
      variable.options.isLate || mayBeUnassigned
        ? (frame) => this.readLocalValue(frame, cell(frame), name)
        : (frame) => cell(frame).v;
    // A const local holds a constant, which other constants may use, as `const b = [...a]`.
    return {
      type,
      run,
      variable,
      isConst:
        variable.options.isConst ||
        (this.potentialConstInitializer && !this.inConstContext && variable.options.isParameter),
    };
  }

  protected readLocalValue(frame: Frame, target: Cell, name: string): Value {
    const value = target.v;
    if (value === UNASSIGNED) return undefined;
    if (value === UNINITIALIZED)
      frame.runtime.throwError('LateError', '', [`Local '${name}' has not been initialized.`]);
    if (value instanceof LateInitializer) {
      const { runtime } = frame;
      const computed = runtime.callValue(value.closure, NO_ARGUMENTS, [], undefined);
      if (value.isFinal && target.v !== value)
        runtime.throwError('LateError', '', [`Local '${name}' has been assigned during initialization.`]);
      target.v = computed;
      return computed;
    }
    return value;
  }

  // code-gauge-allow functionCognitiveComplexity 18 -- Ordinary and pattern assignments share the local write rules.
  protected localWriter(variable: LocalVar, span: Span, readsCurrent = false): (frame: Frame, value: Value) => void {
    const { options, name } = variable;
    if (variable.unavailable) this.error(span, variable.unavailable);
    if (variable.writeError) this.error(span, variable.writeError);
    if (variable.inPatternGuard) this.error(span, `パターン変数 ${name} には、when の中で代入できません。`);
    if (options.isConst) this.error(span, `const の変数 ${name} には代入できません。`);
    if (options.isFinal && options.isLate && (options.hasInitializer || this.flow.assigned.has(variable))) {
      this.error(span, `late final の変数 ${name} には、もう値を代入できません。`);
    }
    if (options.isFinal && !options.isLate) {
      const assigned = options.hasInitializer || options.isParameter || this.flow.maybeAssigned.has(variable);
      if (assigned || variable.owner !== this.fn)
        this.error(span, `final の変数 ${name} には、もう値を代入できません。`);
    }
    if (readsCurrent) this.checkDefinitelyAssigned(variable, span);
    if (variable.owner !== this.fn) variable.isWriteCaptured = true;
    const cell = this.cellAccess(variable);
    const isLateFinal = options.isLate && options.isFinal;
    return (frame, value) => {
      const target = cell(frame);
      if (isLateFinal && target.v !== UNINITIALIZED)
        frame.runtime.throwError('LateError', '', [`Local '${name}' has already been initialized.`]);
      target.v = value;
    };
  }

  /** Rejects reading a late local without an initializer that no path, closures included, can have assigned yet. */
  private checkLateAssignable(variable: LocalVar, span: Span): void {
    if (variable.options.hasInitializer || !this.flow.reachable || this.flow.maybeAssigned.has(variable)) return;
    const { owner, name } = variable;
    if (variable.isWriteCaptured) return;
    if (owner !== this.fn && variable.hasAssignment) return;
    this.error(span, `late の変数 ${name} には、まだどこでも値を代入していないので、使えません。`);
  }

  /** Rejects reading a local that flow analysis cannot prove assigned, as Dart does for non-nullable and final ones. */
  protected checkDefinitelyAssigned(variable: LocalVar, span: Span): void {
    if (variable.unavailable) this.error(span, variable.unavailable);
    const { options } = variable;
    if (options.isLate) {
      this.checkLateAssignable(variable, span);
      return;
    }
    if (options.hasInitializer || options.isParameter || this.flow.assigned.has(variable)) return;
    if (options.isFinal) {
      this.error(span, `final の変数 ${variable.name} は、値を代入する前には使えません。`);
    }
    if (isPotentiallyNullable(variable.type) && variable.type.kind !== 'typeParam') return;
    if (isNullable(variable.type)) return;
    this.error(span, `null にならない変数 ${variable.name} は、値を代入する前には使えません。`);
  }

  protected requireThis(span: Span, name: string): void {
    if (!this.fn.kind.hasThis) {
      if (this.fn.kind.isInitializer) {
        this.error(span, `初期化子の中では、インスタンスのメンバー ${name} は使えません。`);
      }
      this.error(span, `static なメンバーの中では、インスタンスのメンバー ${name} は使えません。`);
    }
  }

  protected thisReceiver(span: Span): Compiled {
    return this.compileThis(span);
  }

  private compileThis(span: Span): Compiled {
    if (!this.fn.kind.hasThis) {
      if (this.fn.kind.isInitializer) return this.error(span, '初期化子の中では this は使えません。');
      return this.error(span, 'this は、インスタンスのメンバーの中でしか使えません。');
    }
    const type = this.fn.kind.extensionOn ?? this.fn.kind.thisType ?? DYNAMIC;
    return { type, run: (frame) => frame.receiver, isConst: false, thisReference: true };
  }

  protected readStatic(member: Member, span: Span): Compiled {
    this.checkUnavailableStaticMember(member.owner, member.name, span);
    switch (member.kind) {
      case 'field': {
        const global = this.globals[member.slot];
        return this.readDeclaration({ kind: 'variable', global }, span);
      }
      case 'getter': {
        const impl = member;
        return {
          type: member.type,
          run: (frame) =>
            (impl.impl as NonNullable<typeof impl.impl>)(
              frame.runtime,
              undefined,
              { positional: [], named: undefined },
              [],
              span.row
            ),
          isConst: false,
        };
      }
      case 'method': {
        const method = member;
        return {
          type: member.type,
          run: (frame) => frame.runtime.tearOff(undefined, method),
          isConst: true,
        };
      }
      default: {
        return this.error(span, `${member.name} には getter がないので、値を読めません。`);
      }
    }
  }

  // Members

  private compileMember(expression: Extract<Expression, { kind: 'member' }>): Compiled {
    const { object, name } = expression;
    const target = this.staticTarget(object);
    if (target) return this.readStaticTarget(target, name, expression);
    if (object.kind === 'super') return this.readSuperMember(name, expression);
    const receiver = this.compileChainPart(object, undefined);
    return this.readMemberOf(receiver, name, expression, expression.nullAware);
  }

  private readonly fieldKeys = new Map<LocalVar | undefined, Map<Member, LocalVar>>();

  /** Whether no declaration in the program keeps a private field of this name from being promoted. */
  protected abstract isPromotableFieldName(name: string): boolean;

  /** The field a member reads: itself, or the field behind a late field's getter. */
  protected abstract backingField(member: Member): FieldMember | undefined;

  private promotableField(compiled: Compiled, member: Member, receiver: Compiled): Compiled {
    const name = member.name;
    if (
      !this.backingField(member)?.isFinal ||
      !name.startsWith('_') ||
      this.isLibraryCode ||
      !this.isPromotableFieldName(name)
    )
      return compiled;
    const parent = receiver.variable;
    if (!receiver.thisReference && (!parent || !this.isPromotable(parent))) return compiled;
    let keys = this.fieldKeys.get(parent);
    if (!keys) this.fieldKeys.set(parent, (keys = new Map()));
    let variable = keys.get(member);
    if (!variable) {
      variable = new LocalVar({ row: member.row ?? 0, column: 0, start: 0, end: 0 }, name, compiled.type, -1, this.fn, {
        isFinal: true,
        isLate: false,
        isConst: false,
        isParameter: false,
        hasInitializer: true,
      });
      variable.fieldReceiver = parent;
      keys.set(member, variable);
    }
    return { ...compiled, type: this.promotedType(variable), variable };
  }

  /** What a member access on a value of the receiver's static type reads, checking nullability. */
  // code-gauge-allow functionCognitiveComplexity 21 -- Resolve static and dynamic reads and their distinct nullable cases.
  protected readMemberOf(receiver: Compiled, name: string, span: Span, nullAware: boolean): Compiled {
    const receiverType = receiver.type;
    if (receiverType.kind === 'void') this.error(span, 'void の値のメンバーは使えません。');
    this.skipOnNull(receiver, nullAware);
    const dispatchType = this.dynamicDispatchType(receiver);
    if (dispatchType) {
      const { run } = receiver;
      const memberName = this.runtimeMemberName(name);
      return {
        type: dispatchType,
        run: (frame) => {
          const value = run(frame);
          if (value === SHORTED) return SHORTED;
          if (nullAware && value === undefined) return SHORTED;
          return frame.runtime.getProperty(value, memberName, span.row);
        },
        isConst: false,
      };
    }
    const lookupType = nullAware ? nonNullable(receiverType) : receiverType;
    const resolved = this.memberFor(receiver, lookupType, name, span);
    if (!resolved) {
      this.checkUnavailableIoMember(lookupType, name, span);
      if (this.lookupMember(lookupType, name, true))
        this.error(span, `${name} には getter がないので、値を読めません。`);
      return this.error(span, `${typeName(nonNullable(receiverType))} 型には ${name} というメンバーがありません。`);
    }
    if (
      !nullAware &&
      isPotentiallyNullable(receiverType) &&
      !this.acceptsNull(resolved) &&
      receiverType.kind !== 'null'
    ) {
      this.error(
        span,
        `${typeName(receiverType)} 型の値は null かもしれないので、${name} を直接は使えません。?. を使うか、null でないことを確かめてください。`
      );
    }
    const compiled = this.readMember(receiver, resolved, name, span, nullAware);
    return nullAware ? compiled : this.promotableField(compiled, resolved.member, receiver);
  }

  /** Reads a member found statically: a field or getter through dynamic dispatch, a method as a tear-off. */
  // code-gauge-allow functionCognitiveComplexity 19 -- Ordinary reads keep record getters and null-shorting dispatch.
  protected readMember(
    receiver: Compiled,
    resolved: ResolvedMember,
    name: string,
    span: Span | undefined,
    nullAware: boolean
  ): Compiled {
    const receiverRun = receiver.run;
    const { member } = resolved;
    const type = resolved.type;
    // Inside a null-shorting chain the value is not null; the end of the chain (compileExpression) makes it nullable.
    if (resolved.extension)
      return this.readExtensionMember(receiverRun, resolved, resolved.extension.typeArgs, span, nullAware);
    if (member.owner === coreTypes.record && member.kind === 'getter') {
      const impl = member.impl as NonNullable<typeof member.impl>;
      return {
        type,
        run: (frame) => {
          const value = receiverRun(frame);
          if (value === SHORTED || (nullAware && value === undefined)) return SHORTED;
          return impl(frame.runtime, value, { positional: [], named: undefined }, [], span?.row);
        },
        isConst: false,
      };
    }
    const isStringLength =
      name === 'length' && receiver.type.kind === 'interface' && receiver.type.cls === coreTypes.string;
    const memberName = this.runtimeMemberName(name);
    return {
      type,
      run: (frame) => {
        const value = receiverRun(frame);
        if (value === SHORTED || (nullAware && value === undefined)) return SHORTED;
        if (isStringLength && typeof value === 'string') return BigInt(value.length);
        return frame.runtime.getProperty(value, memberName, span?.row);
      },
      isConst: isStringLength && receiver.isConst,
      constValue:
        isStringLength && receiver.constValue && typeof receiver.constValue.value === 'string'
          ? { value: BigInt(receiver.constValue.value.length) }
          : undefined,
    };
  }

  private readExtensionMember(
    receiver: Eval,
    { member, type }: ResolvedMember,
    ownerTypeArgs: readonly DartType[],
    span: Span | undefined,
    nullAware: boolean
  ): Compiled {
    const resolveTypes = this.runtimeTypes(ownerTypeArgs);
    const signature = this.runtimeType(type);
    const defaults = member.kind === 'method' ? extensionTearOffDefaults(member) : undefined;
    return {
      type,
      run: (frame) => {
        const value = receiver(frame);
        if (value === SHORTED || (nullAware && value === undefined)) return SHORTED;
        const typeArgs = resolveTypes(frame);
        if (member.kind === 'method') {
          const impl = member.impl as NonNullable<typeof member.impl>;
          const reified = signature(frame) as FunctionType;
          const closure = frame.runtime.tearOff(
            value,
            {
              ...member,
              type: reified,
              impl: (runtime, _receiver, args, methodTypeArgs, callRow) =>
                impl(runtime, value, args, [...typeArgs, ...methodTypeArgs], callRow),
            },
            reified
          );
          closure.dynamicTypeArgumentDefaults = defaults;
          return closure;
        }
        return (member.impl as unknown as Callable)(
          frame.runtime,
          value,
          { positional: [], named: undefined },
          typeArgs,
          span?.row
        );
      },
      isConst: false,
    };
  }

  private readSuperMember(name: string, span: Span): Compiled {
    this.requireThis(span, name);
    const { type: superclass, classAt } = this.superclassOf(span);
    const resolved = this.lookupSuperMember(superclass, name);
    if (!resolved) return this.error(span, `スーパークラスに ${name} というメンバーがありません。`);
    this.requireSuperImplementation(name, span);
    const memberName = this.runtimeMemberName(name);
    const compiled: Compiled = {
      type: resolved.type,
      run: (frame) => {
        const member = frame.runtime.instanceMember(classAt(frame), memberName);
        if (!member)
          return frame.runtime.noSuchMethod(frame.receiver, memberName, 'getter', { positional: [], named: undefined });
        return frame.runtime.readMember(frame.receiver, member, span.row);
      },
      isConst: false,
    };
    return this.promotableField(compiled, resolved.member, this.thisReceiver(span));
  }

  protected staticTarget(object: Expression): StaticTarget | undefined {
    if (object.kind === 'instantiation') {
      const target = this.staticTarget(object.target);
      return target?.kind === 'class' ? this.instantiateStaticTarget(target, object.typeArguments) : undefined;
    }
    if (object.kind === 'member' && object.object.kind === 'identifier' && !object.nullAware) {
      const prefix = object.object.name;
      if (this.library.hasPrefix(prefix) && !this.resolveNameIsValue(prefix, object.object))
        return this.declarationStaticTarget(
          this.library.lookupPrefixed(prefix, object.name),
          object.name,
          prefix,
          object
        );
    }
    if (object.kind !== 'identifier') return undefined;
    const resolution = this.resolveName(object.name, object);
    if (resolution?.kind === 'prefix') return { kind: 'prefix', prefix: resolution.prefix };
    if (resolution?.kind === 'declaration')
      return this.declarationStaticTarget(resolution.declaration, object.name, undefined, object);
    return undefined;
  }

  private instantiateStaticTarget(target: StaticClassTarget, args: TypeSyntax[]): StaticClassTarget {
    const syntax = { ...target.syntax, args };
    const params = target.alias?.typeParams ?? target.cls.typeParams;
    const resolved = this.typeArgumentsFor(params, syntax, syntax.name);
    const template = target.alias?.aliased;
    if (template?.kind !== 'interface') return { ...target, syntax, typeArgs: resolved };
    const mapping = new Map(params.map((param, index) => [param, resolved[index]]));
    return { ...target, syntax, typeArgs: template.args.map((type) => substitute(type, mapping)) };
  }

  private declarationStaticTarget(
    declaration: Declaration | undefined,
    name: string,
    prefix: string | undefined,
    span: Span
  ): StaticTarget | undefined {
    const syntax = { ...at(span), kind: 'named' as const, name, prefix, args: [], nullable: false };
    if (declaration?.kind === 'class') return { kind: 'class', cls: declaration.cls, typeArgs: undefined, syntax };
    if (declaration?.kind === 'extension') return { kind: 'extension', ext: declaration.ext };
    if (declaration?.kind === 'alias') {
      const { alias } = declaration;
      const aliased = this.resolveAlias(alias, span);
      if (aliased.kind === 'interface') {
        return { kind: 'class', cls: aliased.cls, alias, typeArgs: undefined, syntax };
      }
    }
    return undefined;
  }

  private resolveNameIsValue(name: string, span: Span): boolean {
    const resolution = this.resolveName(name, span);
    return resolution !== undefined && resolution.kind !== 'prefix';
  }

  protected readStaticTarget(
    target: NonNullable<ReturnType<ExpressionCompiler['staticTarget']>>,
    name: string,
    span: Span
  ): Compiled {
    if (target.kind === 'prefix') {
      const declaration = this.library.lookupPrefixed(target.prefix, name);
      if (!declaration) return this.undefinedName(span, name, target.prefix);
      return this.readDeclaration(declaration, span);
    }
    if (target.kind === 'extension') {
      const member = target.ext.staticMembers.get(name);
      if (!member) return this.error(span, `拡張 ${target.ext.name ?? ''} に static なメンバー ${name} がありません。`);
      return this.readStatic(member, span);
    }
    const member = target.cls.staticMembers.get(name);
    if (member) return this.readStatic(member, span);
    if (target.cls.constructors.has(name === 'new' ? '' : name))
      return this.compileConstructorTearoff(target.syntax, name, span);
    if (target.cls.staticSetters.has(name)) return this.error(span, `${name} には getter がないので、値を読めません。`);
    return this.error(span, `クラス ${target.cls.name} に static なメンバー ${name} がありません。`);
  }

  private compileIndex(expression: Extract<Expression, { kind: 'index' }>): Compiled {
    if (expression.object.kind === 'super') {
      return this.compileMethodCall(
        this.superReceiver(expression),
        '[]',
        singleArgument(expression.index),
        undefined,
        expression,
        undefined,
        false
      );
    }
    const receiver = this.compileChainPart(expression.object, undefined);
    return this.compileMethodCall(
      receiver,
      '[]',
      singleArgument(expression.index),
      undefined,
      expression,
      undefined,
      expression.nullAware
    );
  }

  protected superReceiver(span: Span): Compiled {
    this.requireThis(span, 'super');
    const { type } = this.superclassOf(span);
    return { type, run: (frame) => frame.receiver, isConst: false, isSuper: true };
  }

  /** `super.m` needs a concrete `m` in the superclass chain; a mixin's superclass is known only at runtime. */
  protected requireSuperImplementation(name: string, span: Span, setter = false): void {
    const cls = this.currentClass;
    if (!cls || cls.kind === 'mixin' || this.isLibraryCode) return;
    const superclass = cls.superclass?.cls;
    const key = this.runtimeMemberName(name);
    const member = setter ? superclass?.setterImplementation(key) : superclass?.implementation(key);
    if (!member && !superclass?.forwardingDeclaration(key, setter))
      this.error(span, `スーパークラスには ${name} の本体がないので、super.${name} は使えません。`);
  }

  protected superclassOf(span: Span): { type: InterfaceType; classAt: (frame: Frame) => ClassInfo } {
    const cls = this.currentClass;
    if (cls?.kind === 'mixin') {
      const type = cls.mixinSuperInterface;
      return {
        type,
        classAt: (frame) => {
          for (
            let current: ClassInfo | undefined = frame.runtime.classOf(frame.receiver);
            current;
            current = current.superclass?.cls
          ) {
            if (current.mixinOf === cls) return current.superclass?.cls ?? coreTypes.object;
          }
          return cls.onTypes[0]?.cls ?? coreTypes.object;
        },
      };
    }
    const superclass = cls?.superclass;
    if (!superclass) return this.error(span, 'このクラスにはスーパークラスがありません。');
    return { type: superclass, classAt: () => superclass.cls };
  }

  // Operators, implemented by OperatorCompiler

  protected abstract compilePrefix(
    expression: Extract<Expression, { kind: 'prefix' }>,
    context: DartType | undefined
  ): Compiled;
  protected abstract compileNullAssert(expression: Extract<Expression, { kind: 'nullAssert' }>): Compiled;
  protected abstract compileBinary(
    expression: Extract<Expression, { kind: 'binary' }>,
    context: DartType | undefined
  ): Compiled;
  protected abstract compileAs(expression: Extract<Expression, { kind: 'as' }>): Compiled;
  protected abstract compileThrow(expression: Extract<Expression, { kind: 'throw' }>): Compiled;
  protected abstract compileConditional(
    expression: Extract<Expression, { kind: 'conditional' }>,
    context: DartType | undefined
  ): Compiled;
  protected abstract compileCascade(
    expression: Extract<Expression, { kind: 'cascade' }>,
    context: DartType | undefined
  ): Compiled;

  /** Assigns through the last selector of a cascade section, whose receiver is already compiled. */
  protected abstract compileAssignmentTo(
    receiver: Compiled,
    selector: CascadeSelector,
    operator: string,
    value: Expression,
    span: Span
  ): Compiled;

  protected abstract compileInstantiation(expression: Extract<Expression, { kind: 'instantiation' }>): Compiled;

  protected typeLiteralValue(type: DartType): Compiled {
    const resolve = this.runtimeType(type);
    return {
      type: interfaceType(coreTypes.type),
      run: (frame) => new DartTypeValue(coreTypes.type, resolve(frame)),
      isConst: !mentionsTypeParams(type),
    };
  }

  // Assignment

  /** Compiles an assignment `target op= value`. */
  protected abstract compileAssignment(expression: Extract<Expression, { kind: 'assign' }>): Compiled;

  /** Compiles `++x`, `x--`, and the like, which assign `x + 1` or `x - 1`. */
  protected abstract compileIncrement(
    operand: Expression,
    operator: '+' | '-',
    isPrefix: boolean,
    span: Span
  ): Compiled;

  static readonly COMPOUND_OPERATORS = COMPOUND_OPERATORS;
}

// Helpers

/** As the VM does, evaluates every embedded expression before converting any of them to a string. */
function interpolateString(frame: Frame, pieces: readonly (string | Eval)[], isConst: boolean): string {
  const mark = frame.temporaries.length;
  try {
    const values = pieces.map((piece) => {
      if (typeof piece === 'string') return piece;
      const value = piece(frame);
      if (isConst && frame.runtime.checkingConstants && !isPrimitive(value)) {
        frame.runtime.throwTypeError('定数の文字列には、数値、bool、String、null のみを埋め込めます。');
      }
      frame.temporaries.push(value);
      return { value };
    });
    const text = new BoundedStringParts(frame.runtime);
    for (const piece of values) text.append(typeof piece === 'string' ? piece : stringOf(frame.runtime, piece.value));
    return text.text();
  } finally {
    frame.temporaries.length = mark;
  }
}

export function isPrimitive(value: Value): value is undefined | boolean | bigint | number | string {
  return value === undefined || typeof value !== 'object';
}

function primitiveEquals(a: Value, b: Value): boolean {
  if (typeof a === 'bigint' && typeof b === 'number') return Number(a) === b;
  if (typeof a === 'number' && typeof b === 'bigint') return a === Number(b);
  return a === b;
}

export function primitiveText(value: undefined | boolean | bigint | number | string): string {
  if (value === undefined) return 'null';
  if (typeof value === 'number') return formatDouble(value);
  return String(value);
}

export function isDoubleContext(context: DartType): boolean {
  const base = context.kind === 'interface' ? context : undefined;
  return base?.cls === coreTypes.double;
}

/** The element type a context gives a collection literal, as `List<int>` gives `int` to `[...]`. */
export function elementTypeOfContext(context: DartType | undefined, cls: ClassInfo): DartType | undefined {
  if (!context) return undefined;
  const base = resolveBound(context);
  if (base.kind !== 'interface') return undefined;
  const target = cls === coreTypes.list && base.cls === coreTypes.iterable ? coreTypes.iterable : cls;
  if (base.cls === coreTypes.iterable || base.cls === coreTypes.object) {
    return base.cls === coreTypes.iterable ? base.args[0] : undefined;
  }
  if (base.cls !== target && !target.isSubclassOf(base.cls)) return undefined;
  return base.args[0];
}

function mapTypesOfContext(context: DartType | undefined): [DartType, DartType] | undefined {
  if (!context) return undefined;
  const base = resolveBound(context);
  if (base.kind !== 'interface' || base.cls !== coreTypes.map) return undefined;
  return [base.args[0] ?? DYNAMIC, base.args[1] ?? DYNAMIC];
}

function recordLiteralBuilder(
  fields: { name: string | undefined; compiled: Compiled }[],
  namedTypes: readonly { name: string }[],
  fieldNames: string | undefined
): Eval {
  return (frame) => {
    const positional: Value[] = [];
    const named = new Map<string, Value>();
    const mark = frame.temporaries.length;
    try {
      for (const { name, compiled } of fields) {
        const value = compiled.run(frame);
        frame.temporaries.push(value);
        if (name === undefined) positional.push(value);
        else named.set(name, value);
      }
    } finally {
      frame.temporaries.length = mark;
    }
    frame.runtime.allocate(fields.length + 1);
    return new DartRecord(
      coreTypes.record,
      positional,
      namedTypes.map(({ name }) => [name, named.get(name)]),
      frame.runtime.recordShapes.shape(fields.length, fieldNames)
    );
  };
}

function extensionTearOffDefaults(member: Member & { kind: 'method' }): readonly DartType[] | undefined {
  if (member.type.typeParams.length === 0 || member.owner.typeParams.length === 0) return undefined;
  const ownerDefaults = instantiateToBounds(member.owner.typeParams);
  const substitutions = new Map(member.owner.typeParams.map((param, index) => [param, ownerDefaults[index]]));
  const signature = substitute(member.type, substitutions) as FunctionType;
  return instantiateToBounds(signature.typeParams);
}

export function inferElementType(types: DartType[]): DartType {
  if (types.length === 0) return DYNAMIC;
  let result = types[0];
  for (const type of types.slice(1)) result = upperBound(result, type);
  return result;
}

export function singleArgument(index: Expression): ArgumentsSyntax {
  return { ...at(index), positional: [index], named: [], order: [{ kind: 'positional', index: 0 }] };
}

export { isNonNullable, objectType, typeParamType, type Arguments };

/**
 * A collection literal's type argument from its context and its elements' types. A context still waiting for a call's
 * type arguments yields to the elements, and with no elements to its greatest closure (`f<T>(List<List<T>> a)` takes
 * `[]` as List<List<Object?>>), except a bare unknown, which leaves the elements' dynamic.
 */
function literalTypeArgument(context: DartType | undefined, elementTypes: DartType[]): DartType {
  if (context && !containsInferenceHole(context)) return context;
  if (context && !isInferenceHole(context) && elementTypes.length === 0) return closeInferenceHoles(context);
  return inferElementType(elementTypes);
}

/** A set or map type whose type arguments are left to the elements. */
function unresolvedCollectionType(kind: 'set' | 'map'): DartType {
  return kind === 'set'
    ? interfaceType(coreTypes.set, [INFERENCE_HOLE])
    : interfaceType(coreTypes.map, [INFERENCE_HOLE, INFERENCE_HOLE]);
}
