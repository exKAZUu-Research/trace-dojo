import type { ExecutionBudget } from '../interpreter/limits';
import type { Scalar } from './arith';
import type { BinaryOperator } from './ast';
import type { PointerByte, PointerOrigin } from './pointerBounds';

export interface ProvenanceSource {
  key: string;
  value: bigint;
  origin?: PointerOrigin;
  byte?: PointerByte;
}

export interface ProvenanceExpression {
  id: number;
  width: 8 | 64;
  value: bigint;
  source?: ProvenanceSource;
  mode?: 'add' | 'xor';
  constant?: bigint;
  terms?: ReadonlyMap<ProvenanceExpression, bigint>;
  sources: ReadonlyMap<string, ProvenanceSource>;
}

interface Input {
  expression: ProvenanceExpression;
  value: Scalar;
}

const algebras = new WeakMap<ExecutionBudget, ProvenanceAlgebra>();

export function provenanceAlgebra(budget: ExecutionBudget): ProvenanceAlgebra {
  let algebra = algebras.get(budget);
  if (!algebra) {
    algebra = new ProvenanceAlgebra(budget);
    algebras.set(budget, algebra);
  }
  return algebra;
}

export class ProvenanceAlgebra {
  private readonly expressions = new Map<string, ProvenanceExpression>();

  constructor(private readonly budget: ExecutionBudget) {}

  constant(value: Scalar, width: 8 | 64): ProvenanceExpression {
    const constant = BigInt.asUintN(width, BigInt(value));
    return this.intern(`c:${width}/${constant}`, { width, value: constant, constant, sources: new Map() });
  }

  source(source: ProvenanceSource, width: 8 | 64): ProvenanceExpression {
    const value = BigInt.asUintN(width, source.value);
    return this.intern(`s:${width}/${source.key}/${value}`, {
      width,
      value,
      source,
      sources: new Map([[source.key, source]]),
    });
  }

  combine(operation: {
    operator?: BinaryOperator | '~';
    value: Scalar;
    inputs: Input[];
    width: 8 | 64;
  }): ProvenanceExpression {
    const { operator, value, width } = operation;
    const inputs = operation.inputs.map((input) => ({
      ...input,
      expression: input.expression.width === width ? input.expression : this.opaque(input.value, [input], width),
    }));
    let result: ProvenanceExpression | undefined;
    if (operator === '+' || operator === '-' || operator === '^')
      result = this.normalize(operator === '^' ? 'xor' : 'add', inputs, width, operator === '-');
    else if (operator === '~')
      result = this.normalize('xor', [...inputs, { expression: this.constant(-1, width), value: -1 }], width, false);
    else result = this.identity(operator, inputs, width);
    return result?.value === BigInt.asUintN(width, BigInt(value))
      ? result
      : this.opaque(value, inputs, width, operator);
  }

  // code-gauge-allow functionCognitiveComplexity 23 -- Neutral and absorbing identities must respect signed division and C shift values in one dispatch.
  private identity(
    operator: BinaryOperator | undefined,
    inputs: Input[],
    width: 8 | 64
  ): ProvenanceExpression | undefined {
    if (!operator || inputs.length !== 2) return;
    let [left, right] = inputs;
    if (['*', '&', '|'].includes(operator) && left.expression.sources.size === 0) [left, right] = [right, left];
    const a = left.expression,
      b = right.expression;
    const mask = (1n << BigInt(width)) - 1n;
    if (b.sources.size === 0) {
      const neutral: Partial<Record<BinaryOperator, bigint>> = { '&': mask, '|': 0n, '*': 1n };
      const absorbing: Partial<Record<BinaryOperator, bigint>> = { '&': 0n, '|': mask, '*': 0n };
      if (neutral[operator] === b.value) return a;
      if (absorbing[operator] === b.value) return this.constant(b.value, width);
      if (operator === '%' && (BigInt(right.value) === 1n || BigInt(right.value) === -1n))
        return this.constant(0, width);
      if (operator === '/' && BigInt(right.value) === 1n) return a;
      if ((operator === '<<' || operator === '>>') && BigInt(right.value) === 0n) return a;
    }
    if ((operator === '&' || operator === '|') && a.id === b.id) return a;
    return undefined;
  }

  // code-gauge-allow functionCognitiveComplexity 27 -- Canonical terms, coefficients and constants must use the same modular domain.
  // code-gauge-allow functionNcss 31 -- One normalization pass creates the interned expression and its remaining sources.
  private normalize(mode: 'add' | 'xor', inputs: Input[], width: 8 | 64, subtract: boolean): ProvenanceExpression {
    const terms = new Map<ProvenanceExpression, bigint>();
    const combine = mode === 'xor' ? (a: bigint, b: bigint): bigint => a ^ b : (a: bigint, b: bigint): bigint => a + b;
    const coefficientWidth = mode === 'xor' ? 1 : width;
    let constant = 0n;
    for (const [index, { expression }] of inputs.entries()) {
      const factor = subtract && index > 0 ? -1n : 1n;
      const component = expression.mode === mode || !expression.mode ? (expression.constant ?? 0n) : 0n;
      constant = combine(constant, component * factor);
      const source =
        expression.mode === mode
          ? expression.terms!
          : expression.constant !== undefined && !expression.mode
            ? []
            : [[expression, 1n] as const];
      for (const [term, weight] of source) {
        this.budget.spend();
        const next = BigInt.asUintN(coefficientWidth, (terms.get(term) ?? 0n) + weight * factor);
        if (next === 0n) terms.delete(term);
        else terms.set(term, next);
      }
    }
    constant = BigInt.asUintN(width, constant);
    if (terms.size === 0) return this.constant(constant, width);
    if (terms.size === 1 && constant === 0n) {
      const [term, weight] = terms.entries().next().value!;
      if (weight === 1n) return term;
    }
    this.budget.spend(terms.size * Math.max(1, Math.ceil(Math.log2(terms.size))));
    const sorted = [...terms].toSorted((a, b) => a[0].id - b[0].id);
    const key = `${mode}:${width}/${constant}/` + sorted.map(([term, weight]) => `${term.id}:${weight}`).join(',');
    let value = constant;
    for (const [term, weight] of terms) value = combine(value, term.value * weight);
    return this.intern(key, {
      width,
      value: BigInt.asUintN(width, value),
      mode,
      constant,
      terms,
      sources: this.sources([...terms.keys()]),
    });
  }

  private opaque(value: Scalar, inputs: Input[], width: 8 | 64, operator?: BinaryOperator | '~'): ProvenanceExpression {
    const parts = inputs.map((input) => `${input.expression.id}:${input.value}`);
    if (operator === '*' || operator === '&' || operator === '|') parts.sort();
    const key = `o:${width}/${operator ?? 'convert'}/${value}/${parts.join(',')}`;
    return this.intern(key, {
      width,
      value: BigInt.asUintN(width, BigInt(value)),
      sources: this.sources(inputs.map((input) => input.expression)),
    });
  }

  private sources(expressions: ProvenanceExpression[]): ReadonlyMap<string, ProvenanceSource> {
    const sources = new Map<string, ProvenanceSource>();
    for (const expression of expressions) {
      this.budget.spend(expression.sources.size);
      for (const [key, source] of expression.sources) sources.set(key, source);
    }
    return sources;
  }

  private intern(key: string, value: Omit<ProvenanceExpression, 'id'>): ProvenanceExpression {
    this.budget.spend(key.length);
    const previous = this.expressions.get(key);
    if (previous) return previous;
    const expression = { ...value, id: this.expressions.size };
    this.expressions.set(key, expression);
    return expression;
  }
}
