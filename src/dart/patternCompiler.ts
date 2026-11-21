// code-gauge-allow-file fileNcss 593 -- Pattern kinds share their type, rooting, and binding helpers.
import type { Expression, ListPatternElement, Pattern, RecordPatternField, Span } from './ast';
import { nullPatternComparison } from './astWalk';
import { CallCompiler } from './callCompiler';
import { type Compiled, type Eval, typeName } from './compilerBase';
import { SHORTED } from './expressionCompiler';
import { listElement, listLength } from './library/nativeSupport';
import type { Frame } from './runtime';
import { Flow, type LocalVar } from './scope';
import { inferObjectPatternType } from './typeInference';
import {
  asInstanceOf,
  coreTypes,
  type DartType,
  DYNAMIC,
  type FunctionType,
  interfaceType,
  isNonNullable,
  isNullable,
  isPotentiallyNullable,
  isSubtype,
  NEVER,
  nonNullable,
  promotionTarget,
  type RecordType,
  resolveBound,
  sameType,
  upperBound,
  vmTypeString,
} from './types';
import { Cell, DartRecord, type Value } from './values';

export type PatternMode = 'match' | 'declare' | 'assign';

interface PatternMatch {
  match: MatchValue;
  irrefutable: boolean;
}

type MatchValue = (frame: Frame, value: Value, cache: PatternCache) => boolean;

export interface CompiledPattern extends Omit<PatternMatch, 'match'> {
  match: (frame: Frame, value: Value, cache?: PatternCache) => boolean;
  variables: Map<string, LocalVar>;
}

export class PatternCache {
  private readonly paths = new Map<unknown, PatternCache>();
  private extracted: { value: Value } | undefined;
  private instantiations: { args: readonly DartType[]; path: PatternCache }[] | undefined;

  private constructor(private readonly roots: Value[]) {}

  static run<T>(frame: Frame, match: (cache: PatternCache) => T): T {
    const values: Value[] = [];
    const roots = (): Value[] => values;
    frame.runtime.roots.add(roots);
    try {
      return match(new PatternCache(values));
    } finally {
      frame.runtime.roots.delete(roots);
    }
  }

  child(key: unknown): PatternCache {
    let child = this.paths.get(key);
    if (!child) {
      child = new PatternCache(this.roots);
      this.paths.set(key, child);
    }
    return child;
  }

  instantiated(args: readonly DartType[]): PatternCache {
    if (args.length === 0) return this;
    const projections = (this.instantiations ??= []);
    const existing = projections.find(
      (entry) => entry.args.length === args.length && entry.args.every((type, index) => sameType(type, args[index]))
    );
    if (existing) return existing.path;
    const path = new PatternCache(this.roots);
    projections.push({ args, path });
    return path;
  }

  read(frame: Frame, extract: () => Value): Value {
    if (this.extracted) return this.extracted.value;
    const value = extract();
    frame.runtime.allocate(1);
    this.roots.push(value);
    this.extracted = { value };
    return value;
  }
}

const MAP_VALUE = Symbol('map value');
const MAP_CONTAINS_KEY = Symbol('map contains key');
const LIST_TAIL = Symbol('list tail');
const SUBLIST = Symbol('sublist');

interface PatternOptions {
  mode: PatternMode;
  isFinal: boolean;
  /** The variables the other side of an `||` pattern declared, which this side must declare alike. */
  shared?: Map<string, LocalVar>;
  /** The names of `shared` this side has declared. */
  sharedUsed?: Set<string>;
  assignments?: Map<LocalVar, PatternWrite>;
}

interface PatternWrite {
  slot: number;
  write: (frame: Frame, value: Value) => void;
}

export abstract class PatternCompiler extends CallCompiler {
  readonly objectPatternTypes = new WeakMap<Pattern, DartType>();
  readonly castPatternContexts = new WeakMap<Pattern, DartType>();
  readonly patternConstants = new WeakMap<Expression, Compiled>();
  readonly listPatternElementTypes = new WeakMap<Pattern, DartType>();
  readonly coverageUnions = new WeakMap<Pattern, readonly Pattern[]>();

  protected compileCasePattern(
    syntax: Pattern,
    subject: Compiled,
    guardSyntax: Expression | undefined
  ): { pattern: CompiledPattern; guard: Eval | undefined; whenFalse: Flow } {
    const before = this.flow;
    const variable = subject.variable && this.isPromotable(subject.variable) ? subject.variable : undefined;
    const current = variable ? this.promotedType(variable) : subject.type;
    const pattern = this.compilePattern(syntax, current, { mode: 'match', isFinal: false });
    for (const binding of pattern.variables.values()) this.flow = this.flow.assign(binding);
    let whenFalse = before;
    if (variable) {
      const [matchedType, unmatchedType] = this.patternTypes(syntax, current, (type) => {
        this.flow = this.flow.rememberTypeTest(variable, type);
        whenFalse = whenFalse.rememberTypeTest(variable, type);
      });
      const matched = promotionTarget(current, matchedType);
      const unmatched = promotionTarget(current, unmatchedType);
      if (matched) this.flow = this.flow.promote(variable, matched);
      if (unmatched) whenFalse = whenFalse.promote(variable, unmatched);
    }
    // A pattern the matched type always satisfies never fails.
    if (this.alwaysMatches(syntax, current)) whenFalse = whenFalse.unreachable;
    if (!guardSyntax) return { pattern, guard: undefined, whenFalse };
    for (const binding of pattern.variables.values()) binding.inPatternGuard = true;
    try {
      const guard = this.compileCondition(guardSyntax);
      this.flow = guard.flow.whenTrue;
      return { pattern, guard: guard.compiled.run, whenFalse: Flow.join(whenFalse, guard.flow.whenFalse) };
    } finally {
      for (const binding of pattern.variables.values()) binding.inPatternGuard = false;
    }
  }

  /** Compiles a pattern against a value of `matchedType`. */
  compilePattern(pattern: Pattern, matchedType: DartType, options: PatternOptions): CompiledPattern {
    const variables = new Map<string, LocalVar>();
    const compiled = this.compilePatternInner(pattern, matchedType, options, variables);
    const { match, irrefutable } = compiled;
    return {
      irrefutable,
      variables,
      match: (frame, value, cache) =>
        cache ? match(frame, value, cache) : PatternCache.run(frame, (created) => match(frame, value, created)),
    };
  }

  /** The type a pattern expects of the value, which declarations use as the context of their initializer. */
  // code-gauge-allow functionCognitiveComplexity 22 -- One case per part of the pattern, matched in Dart's order.
  // code-gauge-allow functionNcss 35 -- One case per kind of pattern, each giving its own context type.
  patternContextType(pattern: Pattern): DartType | undefined {
    switch (pattern.kind) {
      case 'variable':
      case 'wildcard': {
        return pattern.type ? this.resolveType(pattern.type) : undefined;
      }
      case 'assignedVariable': {
        return this.findLocal(pattern.name, pattern)?.type;
      }
      case 'parenthesized': {
        return this.patternContextType(pattern.pattern);
      }
      case 'record': {
        const positional: DartType[] = [];
        const named: { name: string; type: DartType }[] = [];
        for (const field of pattern.fields) {
          const type = this.patternContextType(field.pattern) ?? DYNAMIC;
          if (field.name === undefined) positional.push(type);
          else named.push({ name: field.name, type });
        }
        if ([...positional, ...named.map((field) => field.type)].every((type) => type.kind === 'dynamic'))
          return undefined;
        return {
          kind: 'record',
          positional,
          named: named.toSorted((a, b) => (a.name < b.name ? -1 : 1)),
          nullable: false,
        };
      }
      case 'list': {
        if (pattern.typeArguments?.length === 1)
          return interfaceType(coreTypes.list, [this.resolveType(pattern.typeArguments[0])]);
        const element = this.sharedContext(
          pattern.elements
            .filter((element) => element.kind !== 'rest')
            .map((element) => this.patternContextType(element))
        );
        return element ? interfaceType(coreTypes.list, [element]) : undefined;
      }
      case 'map': {
        if (pattern.typeArguments?.length === 2) {
          return interfaceType(
            coreTypes.map,
            pattern.typeArguments.map((argument) => this.resolveType(argument))
          );
        }
        const value = this.sharedContext(pattern.entries.map((entry) => this.patternContextType(entry.value)));
        return value ? interfaceType(coreTypes.map, [DYNAMIC, value]) : undefined;
      }
      case 'object': {
        return this.resolveType(pattern.type, { allowRaw: true });
      }
      default: {
        return undefined;
      }
    }
  }

  /**
   * The context the subpatterns of a collection pattern give its elements together: the type they all accept, or
   * Never when no type does, as Dart computes their greatest lower bound.
   */
  private sharedContext(contexts: (DartType | undefined)[]): DartType | undefined {
    let shared: DartType | undefined;
    for (const context of contexts) {
      if (!context || context.kind === 'dynamic') continue;
      if (!shared || isSubtype(context, shared)) shared = context;
      else if (!isSubtype(shared, context)) return NEVER;
    }
    return shared;
  }

  private compilePatternInner(
    pattern: Pattern,
    matchedType: DartType,
    options: PatternOptions,
    variables: Map<string, LocalVar>
  ): PatternMatch {
    const { match, irrefutable } = this.compilePatternNode(pattern, matchedType, options, variables);
    return {
      irrefutable,
      match: (frame, value, cache) => {
        frame.temporaries.push(value);
        try {
          return match(frame, value, cache);
        } finally {
          frame.temporaries.pop();
        }
      },
    };
  }

  // code-gauge-allow functionNcss 43 -- One case per part of the pattern, matched in Dart's order.
  private compilePatternNode(
    pattern: Pattern,
    matchedType: DartType,
    options: PatternOptions,
    variables: Map<string, LocalVar>
  ): PatternMatch {
    switch (pattern.kind) {
      case 'parenthesized': {
        return this.compilePatternInner(pattern.pattern, matchedType, options, variables);
      }
      case 'wildcard': {
        if (!pattern.type) return { match: () => true, irrefutable: true };
        const type = this.resolveType(pattern.type);
        this.requireAssignable(type, matchedType, options, pattern);
        return this.typeTest(type, matchedType, () => true, true, options.mode);
      }
      case 'variable': {
        return this.variablePattern(pattern, matchedType, options, variables);
      }
      case 'assignedVariable': {
        return this.assignedVariablePattern(pattern, matchedType, options);
      }
      case 'constant': {
        return this.constantPattern(pattern.value, matchedType);
      }
      case 'relational': {
        return this.relationalPattern(pattern, matchedType);
      }
      case 'or': {
        return this.orPattern(pattern, matchedType, options, variables);
      }
      case 'and': {
        const left = this.compilePatternInner(pattern.left, matchedType, options, variables);
        // The right operand matches the value as the left one narrowed it, as in `double v && > 3`.
        const right = this.compilePatternInner(
          pattern.right,
          this.patternTypes(pattern.left, matchedType)[0],
          options,
          variables
        );
        return {
          match: (frame, value, cache) => left.match(frame, value, cache) && right.match(frame, value, cache),
          irrefutable: left.irrefutable && right.irrefutable,
        };
      }
      case 'cast': {
        return this.castPattern(pattern, matchedType, options, variables);
      }
      case 'nullCheck': {
        const inner = this.compilePatternInner(pattern.pattern, nonNullable(matchedType), options, variables);
        return {
          match: (frame, value, cache) => value !== undefined && inner.match(frame, value, cache),
          irrefutable: !isNullable(matchedType) && inner.irrefutable,
        };
      }
      case 'nullAssert': {
        const inner = this.compilePatternInner(pattern.pattern, nonNullable(matchedType), options, variables);
        return {
          match: (frame, value, cache) => {
            if (value === undefined) frame.runtime.throwTypeError('Null check operator used on a null value');
            return inner.match(frame, value, cache);
          },
          irrefutable: inner.irrefutable,
        };
      }
      case 'list': {
        return this.listPattern(pattern, matchedType, options, variables);
      }
      case 'map': {
        return this.mapPattern(pattern, matchedType, options, variables);
      }
      case 'record': {
        return this.recordPattern(pattern, matchedType, options, variables);
      }
      case 'object': {
        return this.objectPattern(pattern, matchedType, options, variables);
      }
    }
  }

  private variablePattern(
    pattern: Extract<Pattern, { kind: 'variable' }>,
    matchedType: DartType,
    options: PatternOptions,
    variables: Map<string, LocalVar>
  ): PatternMatch {
    const declared = pattern.type ? this.resolveType(pattern.type) : undefined;
    const type = declared ?? matchedType;
    const variable = this.patternVariable(
      pattern,
      pattern.name,
      type,
      { ...options, isFinal: options.isFinal || pattern.isFinal },
      variables
    );
    const { slot } = variable;
    const bind = (frame: Frame, value: Value): boolean => {
      frame.locals[slot] = new Cell(value);
      return true;
    };
    if (!declared) return { match: bind, irrefutable: true };
    this.requireAssignable(declared, matchedType, options, pattern);
    return this.typeTest(declared, matchedType, bind, true, options.mode);
  }

  /** `a || b`, whose two sides must declare the same variables. */
  private orPattern(
    pattern: Extract<Pattern, { kind: 'or' }>,
    matchedType: DartType,
    options: PatternOptions,
    variables: Map<string, LocalVar>
  ): PatternMatch {
    const before = new Set(variables.keys());
    const left = this.compilePatternInner(
      pattern.left,
      matchedType,
      { ...options, shared: undefined, sharedUsed: undefined },
      variables
    );
    const leftVariables = new Map(variables);
    const sharedUsed = new Set<string>();
    const right = this.compilePatternInner(
      pattern.right,
      this.patternTypes(pattern.left, matchedType)[1],
      { ...options, shared: leftVariables, sharedUsed },
      variables
    );
    for (const name of variables.keys()) {
      const declaredByLeft = leftVariables.has(name) && !before.has(name);
      if (declaredByLeft ? !sharedUsed.has(name) : !leftVariables.has(name)) {
        this.error(pattern, `|| の両側で、同じ変数を宣言してください（${name}）。`);
      }
    }
    return {
      match: (frame, value, cache) => left.match(frame, value, cache) || right.match(frame, value, cache),
      irrefutable: left.irrefutable || right.irrefutable,
    };
  }

  private castPattern(
    pattern: Extract<Pattern, { kind: 'cast' }>,
    matchedType: DartType,
    options: PatternOptions,
    variables: Map<string, LocalVar>
  ): PatternMatch {
    this.castPatternContexts.set(pattern, matchedType);
    const type = this.resolveType(pattern.type);
    const inner = this.compilePatternInner(pattern.pattern, type, options, variables);
    const resolve = this.runtimeType(type);
    return {
      match: (frame, value, cache) => {
        const target = resolve(frame);
        if (!this.valueIsAt(frame, value, target)) {
          frame.runtime.throwTypeError(
            `type '${vmTypeString(frame.runtime.runtimeTypeOf(value))}' is not a subtype of type '${vmTypeString(target)}' in type cast`
          );
        }
        return inner.match(frame, value, cache);
      },
      irrefutable: inner.irrefutable,
    };
  }

  private patternVariable(
    span: Span,
    name: string,
    type: DartType,
    options: PatternOptions,
    variables: Map<string, LocalVar>
  ): LocalVar {
    if (variables.has(name) && !options.shared) this.error(span, `変数 ${name} がパターンの中で重複しています。`);
    const shared = options.shared?.get(name);
    if (shared) {
      options.sharedUsed?.add(name);
      if (!sameType(shared.type, type) || shared.options.isFinal !== options.isFinal)
        this.error(span, `|| の両側で、変数 ${name} の型と final をそろえてください。`);
      variables.set(name, shared);
      return shared;
    }
    if (options.mode === 'assign') this.error(span, 'パターンによる代入では、新しい変数を宣言できません。');
    const variable = this.declareLocal(span, name, type, {
      isFinal: options.isFinal,
      isLate: false,
      isConst: false,
      isParameter: false,
      hasInitializer: true,
    });
    variables.set(name, variable);
    return variable;
  }

  /** Whether a pattern matches every value of the type, so that matching it cannot fail. */
  private alwaysMatches(pattern: Pattern, input: DartType): boolean {
    switch (pattern.kind) {
      case 'parenthesized': {
        return this.alwaysMatches(pattern.pattern, input);
      }
      case 'variable':
      case 'wildcard': {
        return !pattern.type || isSubtype(input, this.resolveType(pattern.type));
      }
      case 'nullCheck': {
        return isNonNullable(input) && this.alwaysMatches(pattern.pattern, input);
      }
      case 'nullAssert': {
        return this.alwaysMatches(pattern.pattern, nonNullable(input));
      }
      case 'cast': {
        return this.alwaysMatches(pattern.pattern, this.resolveType(pattern.type));
      }
      case 'and': {
        return this.alwaysMatches(pattern.left, input) && this.alwaysMatches(pattern.right, input);
      }
      case 'or': {
        return this.alwaysMatches(pattern.left, input) || this.alwaysMatches(pattern.right, input);
      }
      default: {
        return false;
      }
    }
  }

  private patternTypes(
    pattern: Pattern,
    input: DartType,
    onTypeTest?: (type: DartType) => void
  ): readonly [matched: DartType, unmatched: DartType] {
    if (pattern.kind === 'parenthesized') return this.patternTypes(pattern.pattern, input, onTypeTest);
    if (pattern.kind === 'and') {
      const [leftMatch, leftFail] = this.patternTypes(pattern.left, input, onTypeTest);
      const [rightMatch, rightFail] = this.patternTypes(pattern.right, leftMatch, onTypeTest);
      return [rightMatch, upperBound(leftFail, rightFail)];
    }
    if (pattern.kind === 'or') {
      const [leftMatch, leftFail] = this.patternTypes(pattern.left, input, onTypeTest);
      const [rightMatch, rightFail] = this.patternTypes(pattern.right, leftFail, onTypeTest);
      return [upperBound(leftMatch, rightMatch), rightFail];
    }
    const comparison = nullPatternComparison(pattern);
    if (comparison === '==') return [input, nonNullable(input)];
    if (comparison === '!=') return [nonNullable(input), input];
    return [this.patternMatchType(pattern, input, onTypeTest), input];
  }

  private patternMatchType(pattern: Pattern, matchedType: DartType, onTypeTest?: (type: DartType) => void): DartType {
    const testedType = this.testedPatternType(pattern, matchedType);
    if (testedType) {
      onTypeTest?.(testedType);
      return isSubtype(matchedType, testedType) ? matchedType : testedType;
    }
    if (pattern.kind === 'nullCheck' || pattern.kind === 'nullAssert')
      return this.patternTypes(pattern.pattern, nonNullable(matchedType), onTypeTest)[0];
    return matchedType;
  }

  private testedPatternType(pattern: Pattern, matchedType: DartType): DartType | undefined {
    switch (pattern.kind) {
      case 'variable':
      case 'wildcard':
      case 'object':
      case 'cast': {
        return pattern.type ? (this.objectPatternTypes.get(pattern) ?? this.resolveType(pattern.type)) : undefined;
      }
      case 'list': {
        return interfaceType(coreTypes.list, [this.listPatternElementType(pattern, matchedType)]);
      }
      case 'map': {
        return interfaceType(coreTypes.map, this.mapPatternTypes(pattern, matchedType));
      }
      case 'record': {
        return this.patternContextType(pattern) ?? recordShape(pattern.fields);
      }
      default: {
        return undefined;
      }
    }
  }

  /** In a declaration or an assignment, a pattern's type must accept the matched value, which nothing tests there. */
  private requireAssignable(type: DartType, matchedType: DartType, options: PatternOptions, span: Span): void {
    if (options.mode === 'match' || matchedType.kind === 'dynamic' || isSubtype(matchedType, type)) return;
    this.error(span, `${typeName(matchedType)} 型の値は、パターンが求める ${typeName(type)} 型に代入できません。`);
  }

  /** Tests the value's type, then runs `then` on it; the test is irrefutable when the matched type is a subtype. */
  private typeTest(
    type: DartType,
    matchedType: DartType,
    then: MatchValue,
    thenIrrefutable: boolean,
    mode: PatternMode = 'match'
  ): PatternMatch {
    if (isSubtype(matchedType, type)) return { match: then, irrefutable: thenIrrefutable };
    const resolve = this.runtimeType(type);
    // A declaration or an assignment casts a dynamic value to the type the pattern needs, as Dart does.
    if (mode !== 'match') {
      return {
        match: (frame, value, cache) => {
          const required = resolve(frame);
          if (!this.valueIsAt(frame, value, required)) {
            frame.runtime.throwTypeError(
              `type '${vmTypeString(frame.runtime.runtimeTypeOf(value))}' is not a subtype of type '${vmTypeString(required)}'`
            );
          }
          return then(frame, value, cache);
        },
        irrefutable: false,
      };
    }
    return {
      match: (frame, value, cache) => this.valueIsAt(frame, value, resolve(frame)) && then(frame, value, cache),
      irrefutable: false,
    };
  }

  private assignedVariablePattern(
    pattern: Extract<Pattern, { kind: 'assignedVariable' }>,
    matchedType: DartType,
    options: PatternOptions
  ): PatternMatch {
    const variable = this.findLocal(pattern.name, pattern);
    if (!variable) return this.error(pattern, `${pattern.name} という変数はありません。`);
    if (options.assignments?.has(variable)) {
      this.error(pattern, `${pattern.name} はこのパターンですでに代入先として使われています。`);
    }
    const write = this.localWriter(variable, pattern);
    if (!isSubtype(matchedType, variable.type) && matchedType.kind !== 'dynamic') {
      this.error(
        pattern,
        `${typeName(matchedType)} 型の値は、${typeName(variable.type)} 型の変数 ${pattern.name} に代入できません。`
      );
    }
    const slot = this.fn.allocateSlot();
    options.assignments?.set(variable, { slot, write });
    this.afterWrite(variable, matchedType.kind === 'dynamic' ? variable.type : matchedType);
    const save = (frame: Frame, value: Value): boolean => {
      frame.locals[slot] = new Cell(value);
      return true;
    };
    return this.typeTest(variable.type, matchedType, save, true, options.mode);
  }

  protected afterWrite(variable: LocalVar | undefined, type: DartType): void {
    if (variable) this.flow = this.flow.write(variable, type, this.isPromotable(variable));
  }

  private constantPattern(value: Expression, matchedType: DartType): PatternMatch {
    const compiled = this.withConstContext(true, () =>
      this.compileExpression(value, matchedType.kind === 'dynamic' ? undefined : nonNullable(matchedType))
    );
    if (!compiled.isConst) this.error(value, 'case のパターンには、定数を書いてください。');
    this.checkConstant(value, compiled);
    this.patternConstants.set(value, compiled);
    const { run } = compiled;
    return {
      match: (frame, actual) => frame.runtime.equals(run(frame), actual),
      irrefutable: false,
    };
  }

  private relationalPattern(pattern: Extract<Pattern, { kind: 'relational' }>, matchedType: DartType): PatternMatch {
    const { operator, value } = pattern;
    const method = matchedType.kind === 'dynamic' ? undefined : this.lookupMember(matchedType, operator, false);
    const parameter = method?.member.kind === 'method' ? (method.type as FunctionType).positional[0] : undefined;
    const operand = this.withConstContext(true, () => this.compileExpression(value, parameter));
    if (!operand.isConst) this.error(value, '比べる相手には、定数を書いてください。');
    this.checkConstant(value, operand);
    const receiver: Compiled = { type: matchedType, run: (frame) => frame.temporaries.at(-1), isConst: false };
    const comparison =
      operator === '==' || operator === '!='
        ? this.equalityOf(receiver, operand, operator === '!=', pattern)
        : this.withConstContext(true, () => this.compileBinaryWithLeft(receiver, operator, value, pattern, undefined));
    const { run } = this.requireBool(comparison, pattern);
    return { match: (frame) => run(frame) === true, irrefutable: false };
  }

  private listPattern(
    pattern: Extract<Pattern, { kind: 'list' }>,
    matchedType: DartType,
    options: PatternOptions,
    variables: Map<string, LocalVar>
  ): PatternMatch {
    const elementType = this.listPatternElementType(pattern, matchedType);
    this.listPatternElementTypes.set(pattern, elementType);
    const listType = interfaceType(coreTypes.list, [elementType]);
    const restIndex = pattern.elements.findIndex((element) => element.kind === 'rest');
    if (pattern.elements.filter((element) => element.kind === 'rest').length > 1) {
      this.error(pattern, 'リストのパターンには、... を 1 つしか書けません。');
    }
    const before = restIndex !== -1 ? pattern.elements.slice(0, restIndex) : pattern.elements;
    const after = restIndex !== -1 ? pattern.elements.slice(restIndex + 1) : [];
    const compileElements = (elements: ListPatternElement[]): ListPatternParts['head'] =>
      elements.map((element) =>
        element.kind === 'wildcard' && element.type === undefined
          ? undefined
          : this.compilePatternInner(element as Pattern, elementType, options, variables)
      );
    const head = compileElements(before);
    const restElement =
      restIndex !== -1 ? (pattern.elements[restIndex] as Extract<ListPatternElement, { kind: 'rest' }>) : undefined;
    const rest = restElement?.pattern
      ? this.compilePatternInner(restElement.pattern, listType, options, variables)
      : undefined;
    const tail = compileElements(after);
    const hasRest = restIndex !== -1;
    const parts: ListPatternParts = { head, rest, tail, hasRest };
    this.requireAssignable(listType, matchedType, options, pattern);
    const typeCheck = this.typeTest(listType, matchedType, () => true, true, options.mode);
    return {
      match: (frame, value, cache) =>
        typeCheck.match(frame, value, cache) && matchListParts(frame, value, parts, cache),
      irrefutable: typeCheck.irrefutable && hasRest && head.length + tail.length === 0 && (!rest || rest.irrefutable),
    };
  }

  private listPatternElementType(pattern: Extract<Pattern, { kind: 'list' }>, matchedType: DartType): DartType {
    if (pattern.typeArguments) {
      if (pattern.typeArguments.length !== 1) this.error(pattern, 'リストのパターンの型引数は 1 つです。');
      return this.resolveType(pattern.typeArguments[0]);
    }
    const base = resolveBound(matchedType);
    const instance = base.kind === 'interface' ? asInstanceOf({ ...base, nullable: false }, coreTypes.list) : undefined;
    return instance?.args[0] ?? DYNAMIC;
  }

  // code-gauge-allow functionCognitiveComplexity 23 -- Type checks, lazy lookups, and subpatterns match in Dart's order.
  // code-gauge-allow functionNcss 34 -- One case per part of the pattern, matched in Dart's order.
  private mapPattern(
    pattern: Extract<Pattern, { kind: 'map' }>,
    matchedType: DartType,
    options: PatternOptions,
    variables: Map<string, LocalVar>
  ): PatternMatch {
    const [keyType, valueType] = this.mapPatternTypes(pattern, matchedType);
    const mapType = interfaceType(coreTypes.map, [keyType, valueType]);
    const entries = pattern.entries.map((entry) => {
      const key = this.withConstContext(true, () => this.compileExpression(entry.key, keyType));
      if (!key.isConst) this.error(entry.key, 'マップのパターンのキーには、定数を書いてください。');
      return {
        key,
        span: entry.key,
        value: this.compilePatternInner(entry.value, valueType, options, variables),
      };
    });
    this.checkMapPatternKeys(pattern, entries);
    this.requireAssignable(mapType, matchedType, options, pattern);
    const typeCheck = this.typeTest(mapType, matchedType, () => true, true, options.mode);
    const nullableValueType = isPotentiallyNullable(valueType) ? this.runtimeType(valueType) : undefined;
    return {
      match: (frame, value, cache) => {
        if (!typeCheck.match(frame, value, cache)) return false;
        const { runtime } = frame;
        for (const entry of entries) {
          const key = entry.key.run(frame);
          const args = { positional: [key], named: undefined };
          const identity = runtime.links.constantIdentityKey(runtime, key);
          const path = cache.child(MAP_VALUE).child(identity);
          const found = path.read(frame, () => runtime.invoke(value, '[]', args, [], undefined));
          if (found === undefined) {
            if (!nullableValueType || !isPotentiallyNullable(nullableValueType(frame))) return false;
            const presence = cache.child(MAP_CONTAINS_KEY).child(identity);
            if (presence.read(frame, () => runtime.invoke(value, 'containsKey', args, [], undefined)) !== true)
              return false;
          }
          if (!entry.value.match(frame, found, path)) return false;
        }
        return true;
      },
      irrefutable: false,
    };
  }

  private checkMapPatternKeys(span: Span, entries: readonly { key: Compiled; span: Span }[]): void {
    if (entries.length === 1) {
      this.checkConstant(entries[0].span, entries[0].key);
      return;
    }
    if (this.isLibraryCode || entries.length === 0) return;
    this.constantChecks.push({
      span,
      run: (frame) => {
        const seen = new Set<string>();
        const { runtime } = frame;
        for (const entry of entries) {
          const key = runtime.links.constantIdentityKey(runtime, entry.key.run(frame));
          if (seen.has(key)) this.error(entry.span, 'マップのパターンに同じキーを 2 回書けません。');
          seen.add(key);
        }
      },
    });
  }

  private mapPatternTypes(pattern: Extract<Pattern, { kind: 'map' }>, matchedType: DartType): readonly DartType[] {
    if (pattern.typeArguments) {
      if (pattern.typeArguments.length !== 2) this.error(pattern, 'マップのパターンの型引数は 2 つです。');
      return pattern.typeArguments.map((type) => this.resolveType(type));
    }
    const base = resolveBound(matchedType);
    const instance = base.kind === 'interface' ? asInstanceOf({ ...base, nullable: false }, coreTypes.map) : undefined;
    return instance?.args ?? [DYNAMIC, DYNAMIC];
  }

  private recordPattern(
    pattern: Extract<Pattern, { kind: 'record' }>,
    matchedType: DartType,
    options: PatternOptions,
    variables: Map<string, LocalVar>
  ): PatternMatch {
    const base = resolveBound(matchedType);
    const recordType = base.kind === 'record' ? base : undefined;
    const positional = pattern.fields.filter((field) => field.name === undefined);
    const named = pattern.fields.filter((field) => field.name !== undefined);
    const names = this.fieldNames(named);
    const shape = recordShape(pattern.fields);
    this.requireAssignable(shape, matchedType, options, pattern);
    const positionalPatterns = positional.map((field, index) =>
      this.compilePatternInner(
        field.pattern,
        recordType && recordType.positional.length === positional.length ? recordType.positional[index] : DYNAMIC,
        options,
        variables
      )
    );
    const namedPatterns = named.map((field) => ({
      name: field.name as string,
      pattern: this.compilePatternInner(
        field.pattern,
        recordType?.named.find((other) => other.name === field.name)?.type ?? DYNAMIC,
        options,
        variables
      ),
    }));
    this.registerRecordFieldNames(shape.named);
    const sortedNames = [...names].toSorted();
    return this.typeTest(
      shape,
      matchedType,
      (frame, value, cache) => matchesRecord(frame, value, positionalPatterns, namedPatterns, sortedNames, cache),
      positionalPatterns.every((field) => field.irrefutable) &&
        namedPatterns.every((field) => field.pattern.irrefutable),
      options.mode
    );
  }

  private fieldNames(named: readonly RecordPatternField[]): Set<string> {
    const names = new Set<string>();
    for (const field of named) {
      if (names.has(field.name as string))
        this.error(field, `フィールド ${field.name} がパターンの中で重複しています。`);
      names.add(field.name as string);
    }
    return names;
  }

  // code-gauge-allow functionCognitiveComplexity 23 -- Resolve object properties and match their projected values.
  private objectPattern(
    pattern: Extract<Pattern, { kind: 'object' }>,
    matchedType: DartType,
    options: PatternOptions,
    variables: Map<string, LocalVar>
  ): PatternMatch {
    const type = this.resolveType(pattern.type, {
      inferOmitted: (template, params) => inferObjectPatternType(matchedType, template, params),
    });
    this.fieldNames(pattern.fields);
    this.objectPatternTypes.set(pattern, type);
    const receiver: Compiled = { type, run: (frame) => frame.temporaries.at(-1), isConst: false };
    const fields = pattern.fields.map((field) => {
      if (field.name === undefined)
        return this.error(field, 'オブジェクトのパターンのフィールドには、名前を書いてください。');
      const member = this.lookupMember(type, field.name, false);
      if (!member) this.error(field, `${typeName(type)} 型には ${field.name} というメンバーがありません。`);
      return {
        projection: member.extension ? member.member : field.name,
        types: member.extension ? this.runtimeTypes(member.extension.typeArgs) : undefined,
        run: this.readMember(receiver, member, field.name, undefined, false).run,
        pattern: this.compilePatternInner(field.pattern, member.type, options, variables),
      };
    });
    const typeCheck = this.typeTest(type, matchedType, () => true, true, options.mode);
    return {
      match: (frame, value, cache) => {
        if (!typeCheck.match(frame, value, cache)) return false;
        for (const field of fields) {
          const projection = cache.child(field.projection);
          const path = field.types ? projection.instantiated(field.types(frame)) : projection;
          const fieldValue = path.read(frame, () => field.run(frame));
          if (!field.pattern.match(frame, fieldValue, path)) return false;
        }
        return true;
      },
      irrefutable: typeCheck.irrefutable && fields.every((field) => field.pattern.irrefutable),
    };
  }

  /** Throws the error a refutable pattern in a declaration or an assignment raises when it fails to match. */
  protected throwPatternMismatch(frame: Frame): never {
    return frame.runtime.throwError('StateError', '', ['Pattern matching error']);
  }

  /** Compiles a pattern assignment `(a, b) = (b, a)`. */
  compilePatternAssignment(pattern: Pattern, value: Expression, span: Span): Compiled {
    const context = this.patternContextType(pattern);
    const compiled = this.compileExpression(value, context);
    const assignments = new Map<LocalVar, PatternWrite>();
    const options: PatternOptions = { mode: 'assign', isFinal: false, assignments };
    if (context) this.requireAssignable(context, compiled.type, options, span);
    const matchedType = compiled.type.kind === 'dynamic' ? (context ?? compiled.type) : compiled.type;
    const check = this.typeTest(matchedType, compiled.type, () => true, true, 'assign');
    const matcher = this.compilePattern(pattern, compiled.type, options);
    const writes = [...assignments.values()];
    if (isRefutableSyntax(pattern)) this.error(span, 'このパターンには合わない値があるので、代入には使えません。');
    const { run } = compiled;
    return {
      type: compiled.type,
      run: (frame) => {
        const result = run(frame);
        if (result === SHORTED) return;
        frame.temporaries.push(result);
        try {
          const matched = PatternCache.run(
            frame,
            (cache) => check.match(frame, result, cache) && matcher.match(frame, result, cache)
          );
          if (!matched) this.throwPatternMismatch(frame);
          for (const { slot, write } of writes) write(frame, (frame.locals[slot] as Cell).v);
          return result;
        } finally {
          for (const { slot } of writes) frame.locals[slot] = undefined;
          frame.temporaries.pop();
        }
      },
      isConst: false,
    };
  }
}

function recordShape(fields: readonly RecordPatternField[]): RecordType {
  const positional = fields.filter((field) => field.name === undefined).map(() => DYNAMIC);
  const named = fields.flatMap((field) => (field.name === undefined ? [] : [{ name: field.name, type: DYNAMIC }]));
  named.sort((a, b) => (a.name < b.name ? -1 : 1));
  return { kind: 'record', positional, named, nullable: false };
}

/**
 * Whether a pattern can fail to match in a way a declaration may not allow: constants, relational patterns, and null
 * checks. Other patterns that do not match the value throw at runtime, as Dart's declarations do.
 */
export function isRefutableSyntax(pattern: Pattern): boolean {
  switch (pattern.kind) {
    case 'constant':
    case 'relational':
    case 'nullCheck': {
      return true;
    }
    case 'or':
    case 'and': {
      return isRefutableSyntax(pattern.left) || isRefutableSyntax(pattern.right);
    }
    case 'parenthesized':
    case 'cast':
    case 'nullAssert': {
      return isRefutableSyntax(pattern.pattern);
    }
    case 'list': {
      return pattern.elements.some((element) =>
        element.kind === 'rest'
          ? element.pattern !== undefined && isRefutableSyntax(element.pattern)
          : isRefutableSyntax(element)
      );
    }
    case 'map': {
      return pattern.entries.some((entry) => isRefutableSyntax(entry.value));
    }
    case 'record':
    case 'object': {
      return pattern.fields.some((field) => isRefutableSyntax(field.pattern));
    }
    default: {
      return false;
    }
  }
}

interface ListPatternParts {
  head: (PatternMatch | undefined)[];
  rest: PatternMatch | undefined;
  tail: ListPatternParts['head'];
  hasRest: boolean;
}

/** Matches a list's length, the elements before and after the rest, and the rest as a new list. */
// code-gauge-allow functionCognitiveComplexity 21 -- The pattern length and three subranges follow the specification.
function matchListParts(frame: Frame, value: Value, parts: ListPatternParts, cache: PatternCache): boolean {
  const { head, rest, tail, hasRest } = parts;
  const { runtime } = frame;
  const minimum = BigInt(head.length + tail.length);
  const count =
    hasRest && minimum === 0n ? 0n : (cache.child('length').read(frame, () => listLength(runtime, value)) as bigint);
  const matchElement = (pattern: PatternMatch, index: bigint, path: PatternCache): boolean =>
    pattern.match(
      frame,
      path.read(frame, () => listElement(runtime, value, index)),
      path
    );
  if (hasRest ? count < minimum : count !== minimum && (minimum > 0n || count > 0n)) return false;
  for (const [index, element] of head.entries()) {
    if (element && !matchElement(element, BigInt(index), cache.child(index))) return false;
  }
  if (rest) {
    const positional = [BigInt(head.length)];
    if (tail.length > 0) positional.push(count - BigInt(tail.length));
    const path = cache.child(SUBLIST).child(positional[0]).child(positional[1]);
    const sublist = path.read(frame, () =>
      runtime.invoke(value, 'sublist', { positional, named: undefined }, [], undefined)
    );
    if (!rest.match(frame, sublist, path)) return false;
  }
  for (const [index, element] of tail.entries()) {
    if (!element) continue;
    const offset = tail.length - index;
    if (!matchElement(element, count - BigInt(offset), cache.child(LIST_TAIL).child(offset))) return false;
  }
  return true;
}

/** Whether a value is a record of the pattern's shape whose fields match their patterns. */
function matchesRecord(
  frame: Frame,
  value: Value,
  positionalPatterns: readonly PatternMatch[],
  namedPatterns: readonly { name: string; pattern: PatternMatch }[],
  sortedNames: readonly string[],
  cache: PatternCache
): boolean {
  if (!(value instanceof DartRecord)) return false;
  if (value.positional.length !== positionalPatterns.length || value.named.length !== sortedNames.length) return false;
  if (!value.named.every(([name], index) => name === sortedNames[index])) return false;
  for (const [index, field] of positionalPatterns.entries())
    if (!field.match(frame, value.positional[index], cache.child(`$${index + 1}`))) return false;
  for (const field of namedPatterns) {
    const entry = value.named.find(([name]) => name === field.name);
    if (!field.pattern.match(frame, entry?.[1], cache.child(field.name))) return false;
  }
  return true;
}
