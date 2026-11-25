import { checkMaskElement, vectorOperand } from './admissibility';
import type { Expression, ExpressionOf, Span } from './ast';
import { ReflectionCompiler } from './reflection';
import { known, type LocalBinding, newArray, runtime, staticResultOf, type TExpr, undefinedValue } from './semaBase';
import { type ArrayType, BOOL, I32, isVectorType, TYPE, type Type, typeName, vectorOf } from './types';
import { UNASSIGNED, type Value, type ZArray } from './values';

/**
 * Vectors, `@Vector(n, T)`, whose operators and builtins work on each element. The compiler writes each element's
 * operation as the scalar expression it is, so that the elements overflow and fold as scalars do.
 */
export abstract class VectorCompiler extends ReflectionCompiler {
  protected compileBuiltin(expression: ExpressionOf<'builtinCall'>, resultType: Type | undefined): TExpr {
    switch (expression.name) {
      case '@Vector': {
        return this.vectorType(expression);
      }
      case '@reduce': {
        return this.reduceVector(expression);
      }
      case '@select': {
        return this.select(expression);
      }
      case '@shuffle': {
        return this.shuffle(expression);
      }
      default: {
        return this.elementwiseBuiltin(expression, resultType) ?? super.compileBuiltin(expression, resultType);
      }
    }
  }

  /**
   * A builtin that Zig applies to each element of vector operands, written as the builtin over each element's scalar;
   * a cast takes each element's result type from the vector it results in.
   */
  private elementwiseBuiltin(expression: ExpressionOf<'builtinCall'>, resultType: Type | undefined): TExpr | undefined {
    const cast = ELEMENTWISE_CASTS.has(expression.name);
    if (!cast && !ELEMENTWISE_BUILTINS.has(expression.name)) return undefined;
    const operands = expression.args.map((arg) => this.compile(arg));
    const vector = operands.map((operand) => operand.type).find((type) => isVectorType(type)) as ArrayType | undefined;
    if (!vector) return undefined;
    for (const operand of operands) {
      if (!isVectorType(operand.type) || operand.type.length !== vector.length)
        this.error(
          operand.span,
          `${expression.name} には、長さ ${vector.length} のベクトルだけを渡してください（${typeName(operand.type)} 型です）。`
        );
    }
    const target = resultType && isVectorType(resultType) ? resultType.child : undefined;
    if (cast && !target) return this.error(expression, `${expression.name} には、ベクトルの結果の型が要ります。`);
    // Each element's call is compiled with the element's result type, which a cast takes its type from.
    return this.elementwise(operands, (elements) => ({ ...expression, args: elements }), Number(vector.length), target);
  }

  protected vectorOperation(expression: ExpressionOf<'binary' | 'unary'>, operands: TExpr[]): TExpr {
    const vector = operands.map((operand) => operand.type).find((type) => isVectorType(type)) as ArrayType;
    const coerced = operands.map((operand, index) => {
      if (isVectorType(operand.type)) {
        if (operand.type.length !== vector.length)
          this.error(expression, `ベクトルの長さが合いません（${vector.length} と ${operand.type.length} です）。`);
        return operand;
      }
      if (operand.type.kind === 'struct' && operand.type.isTuple) return this.coerce(operand, vector, operand.span);
      return this.error(
        index === 0 || expression.kind === 'unary' ? expression : operand.span,
        `ベクトルとスカラー（${typeName(operand.type)} 型）は混ぜて計算できません（@splat でベクトルにしてください）。`
      );
    });
    return this.elementwise(coerced, (elements) =>
      expression.kind === 'unary'
        ? { ...expression, operand: elements[0] }
        : { ...expression, left: elements[0], right: elements[1] }
    );
  }

  private vectorType(expression: ExpressionOf<'builtinCall'>): TExpr {
    this.arity(expression, 2);
    const [lengthArg, childArg] = expression.args;
    const length = this.knownValue(
      this.coerce(this.compile(lengthArg, I32), I32, lengthArg),
      'ベクトルの長さ'
    ) as bigint;
    if (length < 0n) this.error(lengthArg, `ベクトルの長さ ${length} は負の数です。`);
    const child = this.compileType(childArg);
    const scalar =
      child.kind === 'int' ||
      child.kind === 'float' ||
      child.kind === 'bool' ||
      (child.kind === 'pointer' && child.size !== 'slice');
    if (!scalar)
      this.error(
        childArg,
        `ベクトルの要素には、整数・浮動小数点数・bool・ポインタの型を書いてください（${typeName(child)} 型です）。`
      );
    return known(TYPE, vectorOf(length, child), expression);
  }

  /** `@reduce(op, v)`: the elements combined from the first, wrapping for integers' `.Add` and `.Mul`. */
  // code-gauge-allow functionCognitiveComplexity -- Maps each reduction to the scalar operator that Zig applies for the element type.
  private reduceVector(expression: ExpressionOf<'builtinCall'>): TExpr {
    this.arity(expression, 2);
    const [operatorArg, vectorArg] = expression.args;
    const reduceOp = this.langMember('ReduceOp', expression);
    const operation = this.knownValue(this.coerce(this.compile(operatorArg, reduceOp), reduceOp, operatorArg), '演算');
    const name = ['And', 'Or', 'Xor', 'Min', 'Max', 'Add', 'Mul'][Number(operation as bigint)];
    const vector = this.compile(vectorArg);
    if (!isVectorType(vector.type))
      return this.error(vectorArg, `@reduce にはベクトルを渡してください（${typeName(vector.type)} 型です）。`);
    const child = vector.type.child;
    const isBool = child.kind === 'bool';
    const isFloat = child.kind === 'float';
    if (isBool && !['And', 'Or', 'Xor'].includes(name))
      this.error(operatorArg, `bool のベクトルには .${name} は使えません。`);
    if (isFloat && !['Min', 'Max', 'Add', 'Mul'].includes(name))
      this.error(operatorArg, `浮動小数点数のベクトルには .${name} は使えません。`);
    if (vector.type.length === 0n) return this.error(vectorArg, '長さ 0 のベクトルは @reduce できません。');
    const combine = (left: Expression, right: Expression): Expression => {
      const span = { row: expression.row, col: expression.col, endRow: expression.endRow };
      if (name === 'Min' || name === 'Max')
        return { kind: 'builtinCall', ...span, name: `@${name.toLowerCase()}`, args: [left, right] };
      const operator = isBool
        ? ({ And: 'and', Or: 'or', Xor: '!=' } as const)[name as 'And' | 'Or' | 'Xor']
        : ({ And: '&', Or: '|', Xor: '^', Add: isFloat ? '+' : '+%', Mul: isFloat ? '*' : '*%' } as const)[
            name as 'And' | 'Or' | 'Xor' | 'Add' | 'Mul'
          ];
      return { kind: 'binary', ...span, operator, left, right };
    };
    return this.scalarOf(
      [vector],
      ([elements]) => {
        let result = elements[0];
        for (const element of elements.slice(1)) result = combine(result, element);
        return result;
      },
      Number(vector.type.length)
    );
  }

  /** `@select(T, pred, a, b)`: each element from `a` where `pred` is true, else from `b`. */
  private select(expression: ExpressionOf<'builtinCall'>): TExpr {
    this.arity(expression, 4);
    const [childArg, predicateArg, leftArg, rightArg] = expression.args;
    const child = this.compileType(childArg);
    const predicate = vectorOperand(this, this.compile(predicateArg), BOOL, predicateArg, '@select の条件');
    if (!isVectorType(predicate.type)) return predicate;
    const vector = vectorOf(predicate.type.length, child);
    const left = this.coerce(this.compile(leftArg, vector), vector, leftArg);
    const right = this.coerce(this.compile(rightArg, vector), vector, rightArg);
    return this.elementwise([predicate, left, right], ([condition, consequent, otherwise]) => ({
      kind: 'if',
      row: expression.row,
      col: expression.col,
      endRow: expression.endRow,
      condition,
      consequent,
      otherwise,
    }));
  }

  /** `@shuffle(T, a, b, mask)`: each element from `a[m]` for a mask element `m >= 0`, else from `b[~m]`. */
  // code-gauge-allow functionNcss -- Checks each operand and mask element as Zig's Sema does.
  private shuffle(expression: ExpressionOf<'builtinCall'>): TExpr {
    this.arity(expression, 4);
    const [childArg, leftArg, rightArg, maskArg] = expression.args;
    const child = this.compileType(childArg);
    const operand = (arg: Expression): TExpr | undefined => {
      if (arg.kind === 'undefined') return undefined;
      return vectorOperand(this, this.compile(arg), child, arg, '@shuffle の値');
    };
    const left = operand(leftArg);
    const right = operand(rightArg);
    const mask = vectorOperand(this, this.compile(maskArg), I32, maskArg, '@shuffle のマスク');
    const indexes = (this.knownValue(mask, 'マスク') as ZArray).values() as bigint[];
    const sources = [left, right].filter((each): each is TExpr => each !== undefined);
    return this.elementwise(
      sources,
      (elements, position) => {
        const index = indexes[position];
        const fromLeft = index >= 0n;
        const source = fromLeft ? left : right;
        const element = fromLeft ? index : ~index;
        const span = { row: maskArg.row, col: maskArg.col, endRow: maskArg.endRow };
        // An undefined mask element selects an undefined element.
        if (index === undefinedValue(I32)) return { kind: 'undefined', ...span };
        // Zig takes an undefined operand as a vector of no elements, which no mask element may select.
        checkMaskElement(this, index, source ? (source.type as ArrayType).length : 0n, position, maskArg);
        if (!source) return { kind: 'undefined', ...span };
        const holder = elements[sources.indexOf(source)];
        return {
          kind: 'index',
          ...span,
          object: (holder as ExpressionOf<'index'>).object,
          index: { kind: 'integer', ...span, value: element },
        };
      },
      indexes.length,
      child
    );
  }

  /**
   * A vector whose elements are the expression `build` writes over the operands' elements at each position: the
   * operands live in temporaries whose elements `build` receives as index expressions.
   */
  private elementwise(
    operands: readonly TExpr[],
    build: (elements: Expression[], position: number) => Expression,
    length = Number((operands.find((operand) => isVectorType(operand.type))?.type as ArrayType).length),
    elementType?: Type
  ): TExpr {
    const span = operands[0]?.span ?? { row: 0, col: 0, endRow: 0 };
    const { bindings, run } = this.temporaries(operands);
    const elements = this.withScope(
      { locals: new Map(bindings.map((binding) => [binding.name, binding])), parent: this.scope },
      () =>
        Array.from({ length }, (_, position) => {
          this.spendCompilation();
          return this.compile(
            build(
              bindings.map((binding) => elementOf(binding.name, position, span)),
              position
            ),
            elementType
          );
        })
    );
    const type = vectorOf(length, elementType ?? this.peerType(elements, span));
    const result = this.aggregate(
      type,
      elements.map((element) => this.coerce(element, type.child, element.span)),
      span,
      (values) => newArray(values, undefined)
    );
    return result.known
      ? result
      : { ...runtime(type, (frame) => run(frame, result.eval), span), staticResult: staticResultOf(result) };
  }

  /** A scalar that `build` computes from the elements of vectors, such as `@reduce`'s. */
  private scalarOf(operands: readonly TExpr[], build: (elements: Expression[][]) => Expression, length: number): TExpr {
    const span = operands[0].span;
    const { bindings, run } = this.temporaries(operands);
    const result = this.withScope(
      { locals: new Map(bindings.map((binding) => [binding.name, binding])), parent: this.scope },
      () =>
        this.compile(
          build(
            bindings.map((binding) => Array.from({ length }, (_, position) => elementOf(binding.name, position, span)))
          )
        )
    );
    return result.known
      ? result
      : { ...runtime(result.type, (frame) => run(frame, result.eval), span), staticResult: staticResultOf(result) };
  }

  /** Locals that hold the operands while their elements are computed, known when the operands are. */
  private temporaries(operands: readonly TExpr[]): {
    bindings: LocalBinding[];
    run: (frame: Parameters<TExpr['eval']>[0], evaluate: TExpr['eval']) => Value;
  } {
    const bindings = operands.map((operand, index): LocalBinding => {
      const fact = staticResultOf(operand);
      return {
        kind: 'local',
        name: `\u0000vector${index}`,
        slot: this.localSlot(),
        type: operand.type,
        isConst: true,
        known: fact !== undefined,
        value: fact?.value,
      };
    });
    const evaluators = operands.map((operand) => operand.eval);
    return {
      bindings,
      run: (frame, evaluate) => {
        for (const [index, binding] of bindings.entries()) frame.slots[binding.slot] = evaluators[index](frame);
        try {
          return evaluate(frame);
        } finally {
          for (const binding of bindings) frame.slots[binding.slot] = UNASSIGNED;
        }
      },
    };
  }

  private arity(expression: ExpressionOf<'builtinCall'>, count: number): void {
    if (expression.args.length !== count)
      this.error(
        expression,
        `${expression.name} の引数の数が合いません（${count} 個が必要ですが、${expression.args.length} 個です）。`
      );
  }
}

function elementOf(name: string, position: number, { row, col, endRow }: Span): Expression {
  const span = { row, col, endRow };
  return {
    kind: 'index',
    ...span,
    object: { kind: 'identifier', ...span, name },
    index: { kind: 'integer', ...span, value: BigInt(position) },
  };
}

/** The builtins that Zig applies to each element of vector operands. */
const ELEMENTWISE_BUILTINS = new Set([
  '@abs',
  '@sqrt',
  '@sin',
  '@cos',
  '@tan',
  '@exp',
  '@exp2',
  '@log',
  '@log2',
  '@log10',
  '@floor',
  '@ceil',
  '@trunc',
  '@round',
  '@divTrunc',
  '@divFloor',
  '@divExact',
  '@mod',
  '@rem',
  '@min',
  '@max',
  '@clz',
  '@ctz',
  '@popCount',
  '@byteSwap',
  '@bitReverse',
  '@shlExact',
  '@shrExact',
]);

/** The casts that Zig applies to each element, taking each element's result type from the vector's. */
const ELEMENTWISE_CASTS = new Set(['@intCast', '@truncate', '@floatCast', '@floatFromInt', '@intFromFloat']);
