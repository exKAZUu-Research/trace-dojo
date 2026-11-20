// code-gauge-allow-file fileNcss 460 -- The compilation of every kind of pattern, which share their type and binding helpers.
import type { Expression, ListPatternElement, Pattern, RecordPatternField, Span } from './ast';
import { CallCompiler } from './callCompiler';
import { type Compiled, type ResolvedMember, typeName } from './compilerBase';
import { SHORTED } from './expressionCompiler';
import { listElement, listLength } from './library/nativeSupport';
import { DartThrow, type Frame } from './runtime';
import type { LocalVar } from './scope';
import {
  asInstanceOf,
  coreTypes,
  type DartType,
  DYNAMIC,
  interfaceType,
  isNullable,
  isSubtype,
  NEVER,
  nonNullable,
  resolveBound,
  sameType,
  vmTypeString,
} from './types';
import { type Arguments, type Callable, Cell, DartRecord, type Value } from './values';

export type PatternMode = 'match' | 'declare' | 'assign';

/** A compiled pattern: how to match a value, binding variables as it goes, and what it declares. */
export interface CompiledPattern {
  match: (frame: Frame, value: Value) => boolean;
  /** The variables the pattern declares, by name. */
  variables: Map<string, LocalVar>;
  /** Whether the pattern matches every value of the type it was compiled against. */
  irrefutable: boolean;
}

interface PatternOptions {
  mode: PatternMode;
  isFinal: boolean;
  /** The variables the other side of an `||` pattern declared, which this side must declare alike. */
  shared?: Map<string, LocalVar>;
  /** The names of `shared` this side has declared. */
  sharedUsed?: Set<string>;
}

export abstract class PatternCompiler extends CallCompiler {
  /** Compiles a pattern against a value of `matchedType`. */
  compilePattern(pattern: Pattern, matchedType: DartType, options: PatternOptions): CompiledPattern {
    const variables = new Map<string, LocalVar>();
    const compiled = this.compilePatternInner(pattern, matchedType, options, variables);
    return { ...compiled, variables };
  }

  /** The type a pattern expects of the value, which declarations use as the context of their initializer. */
  // code-gauge-allow functionCognitiveComplexity 22 -- One case per part of the pattern, matched in Dart's order.
  // code-gauge-allow functionNcss 33 -- One case per kind of pattern, each giving its own context type.
  patternContextType(pattern: Pattern): DartType | undefined {
    switch (pattern.kind) {
      case 'variable':
      case 'wildcard': {
        return pattern.type ? this.resolveType(pattern.type) : undefined;
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

  // code-gauge-allow functionNcss 43 -- One case per part of the pattern, matched in Dart's order.
  private compilePatternInner(
    pattern: Pattern,
    matchedType: DartType,
    options: PatternOptions,
    variables: Map<string, LocalVar>
  ): Omit<CompiledPattern, 'variables'> {
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
        return this.assignedVariablePattern(pattern, matchedType);
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
          this.narrowedType(pattern.left, matchedType),
          options,
          variables
        );
        return {
          match: (frame, value) => left.match(frame, value) && right.match(frame, value),
          irrefutable: left.irrefutable && right.irrefutable,
        };
      }
      case 'cast': {
        return this.castPattern(pattern, options, variables);
      }
      case 'nullCheck': {
        const inner = this.compilePatternInner(pattern.pattern, nonNullable(matchedType), options, variables);
        return {
          match: (frame, value) => value !== undefined && inner.match(frame, value),
          irrefutable: !isNullable(matchedType) && inner.irrefutable,
        };
      }
      case 'nullAssert': {
        const inner = this.compilePatternInner(pattern.pattern, nonNullable(matchedType), options, variables);
        return {
          match: (frame, value) => {
            if (value === undefined) frame.runtime.throwTypeError('Null check operator used on a null value');
            return inner.match(frame, value);
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
  ): Omit<CompiledPattern, 'variables'> {
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
  ): Omit<CompiledPattern, 'variables'> {
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
      matchedType,
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
      match: (frame, value) => left.match(frame, value) || right.match(frame, value),
      irrefutable: left.irrefutable || right.irrefutable,
    };
  }

  private castPattern(
    pattern: Extract<Pattern, { kind: 'cast' }>,
    options: PatternOptions,
    variables: Map<string, LocalVar>
  ): Omit<CompiledPattern, 'variables'> {
    const type = this.resolveType(pattern.type);
    const inner = this.compilePatternInner(pattern.pattern, type, options, variables);
    const resolve = this.runtimeType(type);
    return {
      match: (frame, value) => {
        const target = resolve(frame);
        if (!this.valueIsAt(frame, value, target)) {
          frame.runtime.throwTypeError(
            `type '${vmTypeString(frame.runtime.runtimeTypeOf(value))}' is not a subtype of type '${vmTypeString(target)}' in type cast`
          );
        }
        return inner.match(frame, value);
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

  /** The type a value of the matched type has once it matches a pattern. */
  private narrowedType(pattern: Pattern, matchedType: DartType): DartType {
    switch (pattern.kind) {
      case 'variable':
      case 'wildcard':
      case 'object':
      case 'cast': {
        if (!pattern.type) return matchedType;
        const type = this.resolveType(pattern.type, { allowRaw: true });
        return isSubtype(matchedType, type) ? matchedType : type;
      }
      case 'nullCheck':
      case 'nullAssert': {
        return this.narrowedType(pattern.pattern, nonNullable(matchedType));
      }
      case 'parenthesized': {
        return this.narrowedType(pattern.pattern, matchedType);
      }
      case 'and': {
        return this.narrowedType(pattern.right, this.narrowedType(pattern.left, matchedType));
      }
      default: {
        return matchedType;
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
    then: (frame: Frame, value: Value) => boolean,
    thenIrrefutable: boolean,
    mode: PatternMode = 'match'
  ): Omit<CompiledPattern, 'variables'> {
    if (isSubtype(matchedType, type)) return { match: then, irrefutable: thenIrrefutable };
    const resolve = this.runtimeType(type);
    // A declaration or an assignment casts a dynamic value to the type the pattern needs, as Dart does.
    if (mode !== 'match') {
      return {
        match: (frame, value) => {
          const required = resolve(frame);
          if (!this.valueIsAt(frame, value, required)) {
            frame.runtime.throwTypeError(
              `type '${vmTypeString(frame.runtime.runtimeTypeOf(value))}' is not a subtype of type '${vmTypeString(required)}'`
            );
          }
          return then(frame, value);
        },
        irrefutable: false,
      };
    }
    return {
      match: (frame, value) => this.valueIsAt(frame, value, resolve(frame)) && then(frame, value),
      irrefutable: false,
    };
  }

  private assignedVariablePattern(
    pattern: Extract<Pattern, { kind: 'assignedVariable' }>,
    matchedType: DartType
  ): Omit<CompiledPattern, 'variables'> {
    const variable = this.findLocal(pattern.name);
    if (!variable) return this.error(pattern, `${pattern.name} という変数はありません。`);
    if (variable.unavailable) this.error(pattern, variable.unavailable);
    if (variable.inPatternGuard) this.error(pattern, `パターン変数 ${pattern.name} には、when の中で代入できません。`);
    if (variable.options.isFinal && (variable.options.hasInitializer || this.flow.maybeAssigned.has(variable))) {
      this.error(pattern, `final の変数 ${pattern.name} には、もう値を代入できません。`);
    }
    if (!isSubtype(matchedType, variable.type) && matchedType.kind !== 'dynamic') {
      this.error(
        pattern,
        `${typeName(matchedType)} 型の値は、${typeName(variable.type)} 型の変数 ${pattern.name} に代入できません。`
      );
    }
    const cell = this.cellAccess(variable);
    if (variable.owner !== this.fn) variable.isWriteCaptured = true;
    this.flow = this.flow.assign(variable).demote(variable);
    return {
      match: (frame, value) => {
        cell(frame).v = value;
        return true;
      },
      irrefutable: true,
    };
  }

  private constantPattern(value: Expression, matchedType: DartType): Omit<CompiledPattern, 'variables'> {
    const compiled = this.withConstContext(true, () =>
      this.compileExpression(value, matchedType.kind === 'dynamic' ? undefined : nonNullable(matchedType))
    );
    if (!compiled.isConst) this.error(value, 'case のパターンには、定数を書いてください。');
    this.checkConstant(value, compiled);
    const { run } = compiled;
    return {
      match: (frame, actual) => frame.runtime.equals(run(frame), actual),
      irrefutable: false,
    };
  }

  // code-gauge-allow functionCognitiveComplexity 17 -- One case per part of the pattern, matched in Dart's order.
  private relationalPattern(
    pattern: Extract<Pattern, { kind: 'relational' }>,
    matchedType: DartType
  ): Omit<CompiledPattern, 'variables'> {
    const operand = this.withConstContext(true, () => this.compileExpression(pattern.value));
    if (!operand.isConst) this.error(pattern.value, '比べる相手には、定数を書いてください。');
    this.checkConstant(pattern.value, operand);
    const { operator } = pattern;
    const { run } = operand;
    if (operator === '==' || operator === '!=') {
      return {
        match: (frame, value) => frame.runtime.equals(value, run(frame)) === (operator === '=='),
        irrefutable: false,
      };
    }
    const receiverType = nonNullable(matchedType);
    if (receiverType.kind !== 'dynamic') {
      const member = this.lookupMember(receiverType, operator, false);
      if (!member) this.error(pattern, `${typeName(matchedType)} 型には演算子 ${operator} がありません。`);
    }
    return {
      match: (frame, value) => {
        if (value === undefined) return false;
        const other = run(frame);
        if (
          (typeof value === 'bigint' || typeof value === 'number') &&
          (typeof other === 'bigint' || typeof other === 'number')
        ) {
          const a = Number(value);
          const b = Number(other);
          if (typeof value === 'bigint' && typeof other === 'bigint') return compareBigints(operator, value, other);
          return compareNumbers(operator, a, b);
        }
        return frame.runtime.invoke(value, operator, { positional: [other], named: undefined }, [], undefined) === true;
      },
      irrefutable: false,
    };
  }

  private listPattern(
    pattern: Extract<Pattern, { kind: 'list' }>,
    matchedType: DartType,
    options: PatternOptions,
    variables: Map<string, LocalVar>
  ): Omit<CompiledPattern, 'variables'> {
    const elementType = this.listPatternElementType(pattern, matchedType);
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
      match: (frame, value) => typeCheck.match(frame, value) && matchListParts(frame, value, parts),
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

  // code-gauge-allow functionCognitiveComplexity 20 -- One case per part of the pattern, matched in Dart's order.
  // code-gauge-allow functionNcss 34 -- One case per part of the pattern, matched in Dart's order.
  private mapPattern(
    pattern: Extract<Pattern, { kind: 'map' }>,
    matchedType: DartType,
    options: PatternOptions,
    variables: Map<string, LocalVar>
  ): Omit<CompiledPattern, 'variables'> {
    let keyType: DartType = DYNAMIC;
    let valueType: DartType = DYNAMIC;
    if (pattern.typeArguments) {
      if (pattern.typeArguments.length !== 2) this.error(pattern, 'マップのパターンの型引数は 2 つです。');
      keyType = this.resolveType(pattern.typeArguments[0]);
      valueType = this.resolveType(pattern.typeArguments[1]);
    } else {
      const base = resolveBound(matchedType);
      const instance =
        base.kind === 'interface' ? asInstanceOf({ ...base, nullable: false }, coreTypes.map) : undefined;
      if (instance) [keyType, valueType] = instance.args;
    }
    const mapType = interfaceType(coreTypes.map, [keyType, valueType]);
    const entries = pattern.entries.map((entry) => {
      const key = this.withConstContext(true, () => this.compileExpression(entry.key, keyType));
      if (!key.isConst) this.error(entry.key, 'マップのパターンのキーには、定数を書いてください。');
      this.checkConstant(entry.key, key);
      return { key: key.run, value: this.compilePatternInner(entry.value, valueType, options, variables) };
    });
    this.requireAssignable(mapType, matchedType, options, pattern);
    const typeCheck = this.typeTest(mapType, matchedType, () => true, true, options.mode);
    return {
      match: (frame, value) => {
        if (!typeCheck.match(frame, value)) return false;
        const { runtime } = frame;
        for (const entry of entries) {
          const key = entry.key(frame);
          if (runtime.invoke(value, 'containsKey', { positional: [key], named: undefined }, [], undefined) !== true)
            return false;
          const found = runtime.invoke(value, '[]', { positional: [key], named: undefined }, [], undefined);
          if (!entry.value.match(frame, found)) return false;
        }
        return true;
      },
      irrefutable: false,
    };
  }

  private recordPattern(
    pattern: Extract<Pattern, { kind: 'record' }>,
    matchedType: DartType,
    options: PatternOptions,
    variables: Map<string, LocalVar>
  ): Omit<CompiledPattern, 'variables'> {
    const base = resolveBound(matchedType);
    const recordType = base.kind === 'record' ? base : undefined;
    const positional = pattern.fields.filter((field) => field.name === undefined);
    const named = pattern.fields.filter((field) => field.name !== undefined);
    const names = this.fieldNames(named);
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
    const shapeMatches =
      recordType !== undefined &&
      !recordType.nullable &&
      recordType.positional.length === positional.length &&
      recordType.named.length === named.length &&
      recordType.named.every((field) => names.has(field.name));
    if (recordType && !shapeMatches && !isNullable(matchedType) && options.mode !== 'match') {
      this.error(pattern, `${typeName(matchedType)} 型の値は、このレコードのパターンと形が合いません。`);
    }
    const sortedNames = [...names].toSorted();
    const shape: DartType = {
      kind: 'record',
      positional: positional.map(() => DYNAMIC),
      named: sortedNames.map((name) => ({ name, type: DYNAMIC })),
      nullable: false,
    };
    const castsDynamic = options.mode !== 'match' && matchedType.kind === 'dynamic';
    return {
      match: (frame, value) => {
        if (castsDynamic && !this.valueIsAt(frame, value, shape)) {
          frame.runtime.throwTypeError(
            `type '${vmTypeString(frame.runtime.runtimeTypeOf(value))}' is not a subtype of type '${vmTypeString(shape)}'`
          );
        }
        return matchesRecord(frame, value, positionalPatterns, namedPatterns, sortedNames);
      },
      irrefutable:
        shapeMatches &&
        positionalPatterns.every((field) => field.irrefutable) &&
        namedPatterns.every((field) => field.pattern.irrefutable),
    };
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

  // code-gauge-allow functionCognitiveComplexity 18 -- One case per part of the pattern, matched in Dart's order.
  private objectPattern(
    pattern: Extract<Pattern, { kind: 'object' }>,
    matchedType: DartType,
    options: PatternOptions,
    variables: Map<string, LocalVar>
  ): Omit<CompiledPattern, 'variables'> {
    let type = this.resolveType(pattern.type, { allowRaw: true });
    if (type.kind === 'interface' && type.args.length === 0 && type.cls.typeParams.length > 0) {
      // `List()` infers its type arguments from the matched type, or else instantiates to bounds.
      const base = resolveBound(matchedType);
      const instance = base.kind === 'interface' ? asInstanceOf({ ...base, nullable: false }, type.cls) : undefined;
      type =
        instance ??
        interfaceType(
          type.cls,
          type.cls.typeParams.map(() => DYNAMIC)
        );
    }
    const fields = pattern.fields.map((field) => {
      if (field.name === undefined)
        return this.error(field, 'オブジェクトのパターンのフィールドには、名前を書いてください。');
      const member = this.lookupMember(type, field.name, false);
      if (!member) this.error(field, `${typeName(type)} 型には ${field.name} というメンバーがありません。`);
      const fieldType = member.type;
      return {
        name: field.name,
        pattern: this.compilePatternInner(field.pattern, fieldType, options, variables),
        member,
      };
    });
    const typeCheck = this.typeTest(type, matchedType, () => true, true, options.mode);
    return {
      match: (frame, value) => {
        if (!typeCheck.match(frame, value)) return false;
        for (const field of fields) {
          const fieldValue = this.readPatternField(frame, value, field.name, field.member);
          if (!field.pattern.match(frame, fieldValue)) return false;
        }
        return true;
      },
      irrefutable: typeCheck.irrefutable && fields.every((field) => field.pattern.irrefutable),
    };
  }

  private readPatternField(frame: Frame, value: Value, name: string, resolved: ResolvedMember): Value {
    if (resolved.extension) {
      const impl = resolved.member.impl as unknown as Callable;
      return impl(
        frame.runtime,
        value,
        { positional: [], named: undefined } as Arguments,
        resolved.extension.typeArgs,
        undefined
      );
    }
    if (value instanceof DartRecord) {
      const position = /^\$([1-9]\d*)$/.exec(name);
      if (position) return value.positional[Number(position[1]) - 1];
      return value.named.find(([field]) => field === name)?.[1];
    }
    return frame.runtime.getProperty(value, name, undefined);
  }

  /** Throws the error a refutable pattern in a declaration or an assignment raises when it fails to match. */
  protected throwPatternMismatch(frame: Frame, value: Value): never {
    void value;
    throw new DartThrow(
      frame.runtime.links.construct(frame.runtime, 'StateError', '', ['Pattern matching error']),
      undefined
    );
  }

  /** Compiles a pattern assignment `(a, b) = (b, a)`. */
  compilePatternAssignment(pattern: Pattern, value: Expression, span: Span): Compiled {
    const compiled = this.compileExpression(value, this.patternContextType(pattern));
    const matcher = this.compilePattern(pattern, compiled.type, { mode: 'assign', isFinal: false });
    if (isRefutableSyntax(pattern)) this.error(span, 'このパターンには合わない値があるので、代入には使えません。');
    const { run } = compiled;
    return {
      type: compiled.type,
      run: (frame) => {
        const result = run(frame);
        if (result === SHORTED) return;
        if (!matcher.match(frame, result)) this.throwPatternMismatch(frame, result);
        return result;
      },
      isConst: false,
    };
  }
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
  head: (Omit<CompiledPattern, 'variables'> | undefined)[];
  rest: Omit<CompiledPattern, 'variables'> | undefined;
  tail: ListPatternParts['head'];
  hasRest: boolean;
}

/** Matches a list's length, the elements before and after the rest, and the rest as a new list. */
// code-gauge-allow functionCognitiveComplexity 20 -- The pattern length and three subranges follow the specification.
function matchListParts(frame: Frame, value: Value, parts: ListPatternParts): boolean {
  const { head, rest, tail, hasRest } = parts;
  const { runtime } = frame;
  const minimum = BigInt(head.length + tail.length);
  const count = hasRest && minimum === 0n ? 0n : listLength(runtime, value);
  if (hasRest ? count < minimum : count !== minimum && (minimum > 0n || count > 0n)) return false;
  for (const [index, element] of head.entries()) {
    if (element && !element.match(frame, listElement(runtime, value, BigInt(index)))) return false;
  }
  if (rest) {
    const positional = [BigInt(head.length)];
    if (tail.length > 0) positional.push(count - BigInt(tail.length));
    const sublist = runtime.invoke(value, 'sublist', { positional, named: undefined }, [], undefined);
    if (!rest.match(frame, sublist)) return false;
  }
  for (const [index, element] of tail.entries()) {
    if (element && !element.match(frame, listElement(runtime, value, count - BigInt(tail.length - index))))
      return false;
  }
  return true;
}

// code-gauge-allow duplicateLines 16 -- Each function handles its own construct; the shared shape reads better than a helper with flags.
function compareBigints(operator: string, a: bigint, b: bigint): boolean {
  switch (operator) {
    case '<': {
      return a < b;
    }
    case '<=': {
      return a <= b;
    }
    case '>': {
      return a > b;
    }
    default: {
      return a >= b;
    }
  }
}

// code-gauge-allow duplicateLines 16 -- Each function handles its own construct; the shared shape reads better than a helper with flags.
function compareNumbers(operator: string, a: number, b: number): boolean {
  switch (operator) {
    case '<': {
      return a < b;
    }
    case '<=': {
      return a <= b;
    }
    case '>': {
      return a > b;
    }
    default: {
      return a >= b;
    }
  }
}

/** Whether a value is a record of the pattern's shape whose fields match their patterns. */
function matchesRecord(
  frame: Frame,
  value: Value,
  positionalPatterns: readonly Omit<CompiledPattern, 'variables'>[],
  namedPatterns: readonly { name: string; pattern: Omit<CompiledPattern, 'variables'> }[],
  sortedNames: readonly string[]
): boolean {
  if (!(value instanceof DartRecord)) return false;
  if (value.positional.length !== positionalPatterns.length || value.named.length !== sortedNames.length) return false;
  if (!value.named.every(([name], index) => name === sortedNames[index])) return false;
  for (const [index, field] of positionalPatterns.entries())
    if (!field.match(frame, value.positional[index])) return false;
  for (const field of namedPatterns) {
    const entry = value.named.find(([name]) => name === field.name);
    if (!field.pattern.match(frame, entry?.[1])) return false;
  }
  return true;
}
