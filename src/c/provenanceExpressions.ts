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

interface BooleanTerm {
  factors: ProvenanceExpression[];
  weight: bigint;
}
type BooleanPolynomial = ReadonlyMap<string, BooleanTerm>;
interface LinearParts {
  constant: bigint;
  terms: ReadonlyMap<ProvenanceExpression, bigint>;
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
  private readonly booleanForms = new Map<number, BooleanPolynomial>();
  private readonly booleanNodes = new Set<number>();
  private readonly linearAliases = new Map<string, ProvenanceExpression>();
  private readonly byteViews = new Map<number, ProvenanceExpression>();
  private readonly inverses = new Map<string, ProvenanceExpression>();

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

  byteView(expression: ProvenanceExpression): ProvenanceExpression | undefined {
    return this.byteViews.get(expression.id);
  }

  registerByteView(expression: ProvenanceExpression, byte: ProvenanceExpression): void {
    if (!this.byteViews.has(expression.id)) {
      this.budget.spend();
      this.byteViews.set(expression.id, byte);
    }
  }

  // code-gauge-allow functionCognitiveComplexity 18 -- One dispatch applies canonical identities and validates them against the evaluated scalar.
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
    const inverseKey = `${operator}/${inputs[0]?.expression.id}/${inputs[1]?.expression.id}`;
    let result = width === 64 ? this.inverses.get(inverseKey) : undefined;
    if (operator === '^' && inputs.some((input) => this.booleanNodes.has(input.expression.id)))
      result = this.booleanExpression('^', inputs, width);
    else if (!result && (operator === '+' || operator === '-' || operator === '^'))
      result = this.normalize(operator === '^' ? 'xor' : 'add', inputs, width, {
        subtract: operator === '-',
      });
    else if (!result && operator === '~')
      result = this.normalize('xor', [...inputs, { expression: this.constant(-1, width), value: -1 }], width);
    else if (!result) {
      result = this.identity(operator, inputs, width);
      if (!result && (operator === '&' || operator === '|')) result = this.booleanExpression(operator, inputs, width);
    }
    const resolved =
      result?.value === BigInt.asUintN(width, BigInt(value)) ? result : this.opaque(value, inputs, width, operator);
    this.registerInverses(operator, value, inputs, resolved);
    return resolved;
  }

  private registerInverses(
    operator: BinaryOperator | '~' | undefined,
    value: Scalar,
    inputs: Input[],
    resolved: ProvenanceExpression
  ): void {
    if (resolved.width !== 64 || inputs.length !== 2) return;
    const [a, b] = inputs;
    if (operator === '*' && BigInt(a.value) * BigInt(b.value) === BigInt(value)) {
      if (BigInt(b.value) !== 0n && [...a.expression.sources.keys()].every((key) => resolved.sources.has(key)))
        this.recordInverse(`//${resolved.id}/${b.expression.id}`, a.expression);
      if (BigInt(a.value) !== 0n && [...b.expression.sources.keys()].every((key) => resolved.sources.has(key)))
        this.recordInverse(`//${resolved.id}/${a.expression.id}`, b.expression);
    }
    if (operator === '<<' && BigInt(a.value) << BigInt(b.value) === BigInt(value))
      this.recordInverse(`>>/${resolved.id}/${b.expression.id}`, a.expression);
  }

  private recordInverse(key: string, target: ProvenanceExpression): void {
    this.budget.spend(key.length + 1);
    this.inverses.set(key, target);
  }

  // code-gauge-allow functionCognitiveComplexity 27 -- Neutral and absorbing identities must respect signed division and C shift values in one dispatch.
  private identity(
    operator: BinaryOperator | '~' | undefined,
    inputs: Input[],
    width: 8 | 64
  ): ProvenanceExpression | undefined {
    if (!operator || operator === '~' || inputs.length !== 2) return;
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
      if (operator === '<<') return this.normalize('add', [left], width, { scales: [1n << BigInt(right.value)] });
      if (operator === '*') return this.normalize('add', [left], width, { scales: [b.value] });
    }
    if ((operator === '&' || operator === '|') && a.id === b.id) return a;
    return undefined;
  }

  // code-gauge-allow functionCognitiveComplexity 27 -- Canonical terms, coefficients and constants must use the same modular domain.
  // code-gauge-allow functionNcss 32 -- One normalization pass creates the interned expression and its remaining sources.
  private normalize(
    mode: 'add' | 'xor',
    inputs: Input[],
    width: 8 | 64,
    options?: { subtract?: boolean; scales?: readonly bigint[] }
  ): ProvenanceExpression {
    const terms = new Map<ProvenanceExpression, bigint>();
    const combine = mode === 'xor' ? (a: bigint, b: bigint): bigint => a ^ b : (a: bigint, b: bigint): bigint => a + b;
    const coefficientWidth = mode === 'xor' ? 1 : width;
    let constant = 0n;
    for (const [index, { expression }] of inputs.entries()) {
      const factor = (options?.scales?.[index] ?? 1n) * (options?.subtract && index > 0 ? -1n : 1n);
      const parts = mode === 'add' ? this.linearParts(expression) : this.partsOf(expression, mode);
      constant = combine(constant, parts.constant * factor);
      const source = parts.terms;
      this.accumulateTerms(terms, source, factor, coefficientWidth);
    }
    constant = BigInt.asUintN(width, constant);
    if (terms.size === 0) return this.constant(constant, width);
    if (terms.size === 1 && constant === 0n) {
      const [term, weight] = terms.entries().next().value!;
      if (weight === 1n) return term;
    }
    const key = this.formKey(mode, width, constant, terms);
    const alias = mode === 'add' ? this.linearAliases.get(key) : undefined;
    if (alias) return alias;
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

  private partsOf(expression: ProvenanceExpression, mode: 'add' | 'xor'): LinearParts {
    if (expression.mode === mode) return { constant: expression.constant!, terms: expression.terms! };
    if (!expression.mode && expression.constant !== undefined)
      return { constant: expression.constant, terms: new Map() };
    return { constant: 0n, terms: new Map([[expression, 1n]]) };
  }

  private linearParts(expression: ProvenanceExpression): LinearParts {
    if (expression.mode !== 'xor' && !this.booleanNodes.has(expression.id)) return this.partsOf(expression, 'add');
    const terms = new Map<ProvenanceExpression, bigint>();
    let constant = 0n;
    for (const [key, term] of this.booleanParts(expression)) {
      const monomial = this.fromBoolean(new Map([[key, { ...term, weight: 1n }]]), expression.width);
      const parts = this.partsOf(monomial, 'add');
      constant += parts.constant * term.weight;
      this.accumulateTerms(terms, parts.terms, term.weight, expression.width);
    }
    for (const [term, weight] of terms) if (weight === 0n) terms.delete(term);
    constant = BigInt.asUintN(expression.width, constant);
    const key = this.formKey('add', expression.width, constant, terms);
    if (!this.linearAliases.has(key)) this.linearAliases.set(key, expression);
    return { constant, terms };
  }

  private accumulateTerms(
    terms: Map<ProvenanceExpression, bigint>,
    source: ReadonlyMap<ProvenanceExpression, bigint>,
    factor: bigint,
    width: number
  ): void {
    for (const [term, weight] of source) {
      this.budget.spend();
      const next = BigInt.asUintN(width, (terms.get(term) ?? 0n) + weight * factor);
      if (next === 0n) terms.delete(term);
      else terms.set(term, next);
    }
  }

  private booleanExpression(operator: '&' | '|' | '^', inputs: Input[], width: 8 | 64): ProvenanceExpression {
    const [a, b] = inputs.map((input) => this.booleanParts(input.expression));
    return this.fromBoolean(this.booleanOperation(operator, a, b, width), width);
  }

  private booleanParts(expression: ProvenanceExpression): BooleanPolynomial {
    const previous = this.booleanForms.get(expression.id);
    if (previous) return previous;
    const width = expression.width;
    let terms: BooleanPolynomial;
    if (expression.mode === 'xor') {
      terms = this.booleanParts(this.constant(expression.constant!, width));
      for (const term of expression.terms!.keys())
        terms = this.booleanOperation('^', terms, this.booleanParts(term), width);
    } else if (expression.sources.size === 0 && expression.value === 0n) terms = new Map();
    else if (expression.sources.size === 0 && expression.value === (1n << BigInt(width)) - 1n)
      terms = new Map([['', { factors: [], weight: 1n }]]);
    else terms = new Map([[String(expression.id), { factors: [expression], weight: 1n }]]);
    this.booleanForms.set(expression.id, terms);
    return terms;
  }

  // code-gauge-allow functionCognitiveComplexity 17 -- Boolean products and sums must share canonical monomial keys and modular coefficients.
  private booleanOperation(
    operator: '&' | '|' | '^',
    a: BooleanPolynomial,
    b: BooleanPolynomial,
    width: 8 | 64
  ): BooleanPolynomial {
    const product = new Map<string, BooleanTerm>();
    for (const x of a.values())
      for (const y of b.values()) {
        this.budget.spend(x.factors.length + y.factors.length + 1);
        const factors = [
          ...new Map([...x.factors, ...y.factors].map((factor) => [factor.id, factor])).values(),
        ].toSorted((left, right) => left.id - right.id);
        const key = factors.map((factor) => factor.id).join('&');
        const weight = BigInt.asUintN(width, (product.get(key)?.weight ?? 0n) + x.weight * y.weight);
        if (weight === 0n) product.delete(key);
        else product.set(key, { factors, weight });
      }
    if (operator === '&') return product;
    const result = new Map<string, BooleanTerm>();
    for (const [polynomial, factor] of [
      [a, 1n],
      [b, 1n],
      [product, operator === '^' ? -2n : -1n],
    ] as const) {
      this.budget.spend(polynomial.size);
      for (const [key, term] of polynomial) {
        const weight = BigInt.asUintN(width, (result.get(key)?.weight ?? 0n) + term.weight * factor);
        if (weight === 0n) result.delete(key);
        else result.set(key, { factors: term.factors, weight });
      }
    }
    return result;
  }

  private fromBoolean(terms: BooleanPolynomial, width: 8 | 64): ProvenanceExpression {
    if (terms.size === 0) return this.constant(0, width);
    if (terms.size === 1) {
      const [term] = terms.values();
      if (term.weight === 1n && term.factors.length === 0) return this.constant(-1, width);
      if (term.weight === 1n && term.factors.length === 1) return term.factors[0];
    }
    this.budget.spend(terms.size * Math.max(1, Math.ceil(Math.log2(terms.size))));
    const key =
      `bool:${width}/` +
      [...terms]
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([at, term]) => `${at}:${term.weight}`)
        .join(',');
    let value = 0n;
    for (const term of terms.values()) {
      this.budget.spend(term.factors.length);
      value += term.weight * term.factors.reduce((bits, factor) => bits & factor.value, (1n << BigInt(width)) - 1n);
    }
    const expression = this.intern(key, {
      width,
      value: BigInt.asUintN(width, value),
      sources: this.sources([...terms.values()].flatMap((term) => term.factors)),
    });
    this.booleanForms.set(expression.id, terms);
    this.booleanNodes.add(expression.id);
    return expression;
  }

  private formKey(
    mode: 'add' | 'xor',
    width: 8 | 64,
    constant: bigint,
    terms: ReadonlyMap<ProvenanceExpression, bigint>
  ): string {
    this.budget.spend(terms.size * Math.max(1, Math.ceil(Math.log2(terms.size))));
    return (
      `${mode}:${width}/${constant}/` +
      [...terms]
        .toSorted((a, b) => a[0].id - b[0].id)
        .map(([term, weight]) => `${term.id}:${weight}`)
        .join(',')
    );
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
