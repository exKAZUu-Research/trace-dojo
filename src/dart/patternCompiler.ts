import type { Expression, ListPatternElement, Pattern, Span } from './ast';
import { CallCompiler } from './callCompiler';
import { type Compiled, type ResolvedMember, typeName } from './compilerBase';
import { SHORTED } from './expressionCompiler';
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
  isTop,
  nonNullable,
  objectType,
  resolveBound,
  sameType,
  typeToString,
} from './types';
import { type Arguments, type Callable, Cell, DartList, DartRecord, type Value } from './values';

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
}

export abstract class PatternCompiler extends CallCompiler {
  /** Compiles a pattern against a value of `matchedType`. */
  compilePattern(pattern: Pattern, matchedType: DartType, options: PatternOptions): CompiledPattern {
    const variables = new Map<string, LocalVar>();
    const compiled = this.compilePatternInner(pattern, matchedType, options, variables);
    return { ...compiled, variables };
  }

  /** The type a pattern expects of the value, which declarations use as the context of their initializer. */
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
        return undefined;
      }
      case 'object': {
        return this.resolveType(pattern.type, { allowRaw: true });
      }
      default: {
        return undefined;
      }
    }
  }

  // code-gauge-allow functionNcss 150 -- One case per kind of pattern.
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
        return this.typeTest(type, matchedType, () => true, true);
      }
      case 'variable': {
        const declared = pattern.type ? this.resolveType(pattern.type) : undefined;
        const type = declared ?? matchedType;
        const variable = this.patternVariable(pattern, pattern.name, type, options, variables);
        const { slot } = variable;
        const bind = (frame: Frame, value: Value): boolean => {
          frame.locals[slot] = new Cell(value);
          return true;
        };
        if (!declared) return { match: bind, irrefutable: true };
        return this.typeTest(declared, matchedType, bind, true);
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
        const left = this.compilePatternInner(pattern.left, matchedType, { ...options, shared: undefined }, variables);
        const leftVariables = new Map(variables);
        const right = this.compilePatternInner(
          pattern.right,
          matchedType,
          { ...options, shared: leftVariables },
          variables
        );
        for (const name of leftVariables.keys()) {
          if (!variables.has(name)) this.error(pattern, `|| の両側で、同じ変数を宣言してください（${name}）。`);
        }
        return {
          match: (frame, value) => left.match(frame, value) || right.match(frame, value),
          irrefutable: left.irrefutable || right.irrefutable,
        };
      }
      case 'and': {
        const left = this.compilePatternInner(pattern.left, matchedType, options, variables);
        const right = this.compilePatternInner(pattern.right, matchedType, options, variables);
        return {
          match: (frame, value) => left.match(frame, value) && right.match(frame, value),
          irrefutable: left.irrefutable && right.irrefutable,
        };
      }
      case 'cast': {
        const type = this.resolveType(pattern.type);
        const inner = this.compilePatternInner(pattern.pattern, type, options, variables);
        const resolve = this.runtimeType(type);
        return {
          match: (frame, value) => {
            const target = resolve(frame);
            if (!this.valueIsAt(frame, value, target)) {
              frame.runtime.throwTypeError(
                `type '${typeToString(frame.runtime.runtimeTypeOf(value))}' is not a subtype of type '${typeToString(target)}' in type cast`
              );
            }
            return inner.match(frame, value);
          },
          irrefutable: inner.irrefutable,
        };
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
      if (!sameType(shared.type, type)) this.error(span, `|| の両側で、変数 ${name} の型を同じにしてください。`);
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

  /** Tests the value's type, then runs `then` on it; the test is irrefutable when the matched type is a subtype. */
  private typeTest(
    type: DartType,
    matchedType: DartType,
    then: (frame: Frame, value: Value) => boolean,
    thenIrrefutable: boolean
  ): Omit<CompiledPattern, 'variables'> {
    if (isSubtype(matchedType, type)) return { match: then, irrefutable: thenIrrefutable };
    const resolve = this.runtimeType(type);
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
    const { run } = compiled;
    return {
      match: (frame, actual) => frame.runtime.equals(run(frame), actual),
      irrefutable: false,
    };
  }

  private relationalPattern(
    pattern: Extract<Pattern, { kind: 'relational' }>,
    matchedType: DartType
  ): Omit<CompiledPattern, 'variables'> {
    const operand = this.withConstContext(true, () => this.compileExpression(pattern.value));
    if (!operand.isConst) this.error(pattern.value, '比べる相手には、定数を書いてください。');
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

  // code-gauge-allow functionCognitiveComplexity 30 -- A list pattern matches the length, the elements, and the rest.
  private listPattern(
    pattern: Extract<Pattern, { kind: 'list' }>,
    matchedType: DartType,
    options: PatternOptions,
    variables: Map<string, LocalVar>
  ): Omit<CompiledPattern, 'variables'> {
    let elementType: DartType;
    if (pattern.typeArguments) {
      if (pattern.typeArguments.length !== 1) this.error(pattern, 'リストのパターンの型引数は 1 つです。');
      elementType = this.resolveType(pattern.typeArguments[0]);
    } else {
      const base = resolveBound(matchedType);
      const instance =
        base.kind === 'interface' ? asInstanceOf({ ...base, nullable: false }, coreTypes.list) : undefined;
      elementType =
        instance?.args[0] ??
        (base.kind === 'dynamic' || isTop(base) || (base.kind === 'interface' && base.cls === coreTypes.object)
          ? DYNAMIC
          : DYNAMIC);
    }
    const listType = interfaceType(coreTypes.list, [elementType]);
    const restIndex = pattern.elements.findIndex((element) => element.kind === 'rest');
    if (pattern.elements.filter((element) => element.kind === 'rest').length > 1) {
      this.error(pattern, 'リストのパターンには、... を 1 つしか書けません。');
    }
    const before = restIndex !== -1 ? pattern.elements.slice(0, restIndex) : pattern.elements;
    const after = restIndex !== -1 ? pattern.elements.slice(restIndex + 1) : [];
    const compileElements = (elements: ListPatternElement[]): Omit<CompiledPattern, 'variables'>[] =>
      elements.map((element) => this.compilePatternInner(element as Pattern, elementType, options, variables));
    const head = compileElements(before);
    const restElement =
      restIndex !== -1 ? (pattern.elements[restIndex] as Extract<ListPatternElement, { kind: 'rest' }>) : undefined;
    const rest = restElement?.pattern
      ? this.compilePatternInner(restElement.pattern, listType, options, variables)
      : undefined;
    const tail = compileElements(after);
    const minimum = head.length + tail.length;
    const hasRest = restIndex !== -1;
    const resolveElement = this.runtimeType(elementType);
    const typeCheck = this.typeTest(listType, matchedType, () => true, true);
    return {
      match: (frame, value) => {
        if (!typeCheck.match(frame, value)) return false;
        const list = value as DartList;
        const elements = list instanceof DartList ? list.elements : [];
        const count = elements.length;
        if (hasRest ? count < minimum : count !== minimum) return false;
        for (const [index, element] of head.entries()) if (!element.match(frame, elements[index])) return false;
        if (rest) {
          const sublist = new DartList(
            coreTypes.list,
            resolveElement(frame),
            elements.slice(head.length, count - tail.length),
            true
          );
          if (!rest.match(frame, sublist)) return false;
        }
        for (const [index, element] of tail.entries()) {
          if (!element.match(frame, elements[count - tail.length + index])) return false;
        }
        return true;
      },
      irrefutable: typeCheck.irrefutable && hasRest && minimum === 0 && (!rest || rest.irrefutable),
    };
  }

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
      return { key: key.run, value: this.compilePatternInner(entry.value, valueType, options, variables) };
    });
    const typeCheck = this.typeTest(mapType, matchedType, () => true, true);
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
    const names = new Set<string>();
    for (const field of named) {
      if (names.has(field.name as string))
        this.error(field, `フィールド ${field.name} がパターンの中で重複しています。`);
      names.add(field.name as string);
    }
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
    return {
      match: (frame, value) => {
        if (!(value instanceof DartRecord)) return false;
        if (value.positional.length !== positional.length || value.named.length !== sortedNames.length) return false;
        if (!value.named.every(([name], index) => name === sortedNames[index])) return false;
        for (const [index, field] of positionalPatterns.entries())
          if (!field.match(frame, value.positional[index])) return false;
        for (const field of namedPatterns) {
          const entry = value.named.find(([name]) => name === field.name);
          if (!field.pattern.match(frame, entry?.[1])) return false;
        }
        return true;
      },
      irrefutable:
        shapeMatches &&
        positionalPatterns.every((field) => field.irrefutable) &&
        namedPatterns.every((field) => field.pattern.irrefutable),
    };
  }

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
      const fieldType = member.member.kind === 'method' ? member.type : member.type;
      return {
        name: field.name,
        pattern: this.compilePatternInner(field.pattern, fieldType, options, variables),
        member,
      };
    });
    const typeCheck = this.typeTest(type, matchedType, () => true, true);
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
    if (!matcher.irrefutable) this.error(span, 'このパターンには合わない値があるので、代入には使えません。');
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

  static readonly OBJECT = objectType();
}

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
