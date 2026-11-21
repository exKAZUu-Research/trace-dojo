// code-gauge-allow-file fileNcss 477 -- Switch coverage shares type partitions and pattern coverage rules.
import type { Expression, Pattern, Span } from './ast';
import { nullPatternComparison } from './astWalk';
import type { ClassInfo, FieldMember } from './classes';
import type { PatternCompiler } from './patternCompiler';
import type { Frame } from './runtime';
import {
  asInstanceOf,
  coreTypes,
  type DartType,
  DYNAMIC,
  interfaceType,
  isNullable,
  isPotentiallyNullable,
  isSubtype,
  nonNullable,
  NULL,
  overapproximateType,
  resolveBound,
  substitute,
  typeToString,
} from './types';
import { DartObject, type Value } from './values';

/** One case of the values a switch must cover: a constant, null, or every value of a type. */
interface ListSpace {
  kind: 'list';
  type: DartType;
  elementType: DartType;
  length: number;
  hasLongerLengths: boolean;
  elements?: readonly Space[];
}

type Space =
  | ListSpace
  | { kind: 'constant'; key: boolean | FieldMember; type: DartType; text: string; subject?: DartType }
  | { kind: 'null' }
  | { kind: 'type'; type: DartType; properties?: ReadonlyMap<string, Space> }
  | { kind: 'record'; fields: Space[]; names: (string | undefined)[]; type: DartType };

type Coverage = boolean | ((frame: Frame) => boolean);

const MAX_SPACES = 256;

/**
 * Whether the patterns (of cases without guards) cover every value of `type`. A switch expression, or a switch
 * statement on a type Dart requires to be covered (bool, enums, sealed classes, and records and nullable types of
 * them), is rejected when they do not.
 */
// code-gauge-allow functionCognitiveComplexity 17 -- Report uncovered partitions now or after constant evaluation.
export function checkExhaustive(
  compiler: PatternCompiler,
  type: DartType,
  patterns: Pattern[],
  span: Span,
  isStatement: boolean
): boolean {
  if (patterns.some((pattern) => coversAll(compiler, pattern, type))) return true;
  const cutoff = Math.min(MAX_SPACES - 1, listLengthCutoff(patterns));
  const depth = Math.max(0, ...patterns.map(listNesting));
  const coverage = new ObjectSpaces(compiler, cutoff, depth);
  const spaces = coverage.refine(expand(type, cutoff, depth), patterns);
  const pending: { space: Space; test: (frame: Frame) => boolean }[] = [];
  const mustCover = !isStatement || isAlwaysExhaustive(type);
  const reportMissing = (space: Space): never =>
    compiler.error(
      span,
      `switch が ${typeToString(type)} 型のすべての値を扱っていません（${spaceText(space)} の場合がありません）。`
    );
  for (const space of spaces) {
    const test = combineCoverage(patterns, (pattern) => covers(compiler, pattern, space), false);
    if (test === false) {
      if (mustCover) reportMissing(space);
      return false;
    }
    if (typeof test === 'function') pending.push({ space, test });
  }
  if (pending.length === 0) return true;
  if (!mustCover) return false;
  compiler.constantChecks.push({
    span,
    run: (frame) => {
      for (const { space, test } of pending) if (!test(frame)) reportMissing(space);
      return;
    },
  });
  return true;
}

function combineCoverage<T>(values: Iterable<T>, check: (value: T) => Coverage, every: boolean): Coverage {
  const pending: ((frame: Frame) => boolean)[] = [];
  for (const value of values) {
    const result = check(value);
    if (result === !every) return !every;
    if (typeof result === 'function') pending.push(result);
  }
  if (pending.length === 0) return every;
  return (frame) => {
    for (const test of pending) if (test(frame) === !every) return !every;
    return every;
  };
}

class ObjectSpaces {
  constructor(
    private readonly compiler: PatternCompiler,
    private readonly listCutoff: number,
    private readonly listDepth: number
  ) {}

  refine(spaces: Space[], patterns: Pattern[]): Space[] {
    if (patterns.length === 0) return spaces;
    const parts = patterns.flatMap(patternAlternatives);
    const result: Space[] = [];
    for (const space of spaces) {
      const refined = this.refineSpace(space, parts);
      if (result.length + refined.length > MAX_SPACES) return spaces;
      result.push(...refined);
    }
    return result;
  }

  private refineSpace(space: Space, parts: Pattern[]): Space[] {
    if (space.kind === 'record') {
      const fields = this.refineFields(space.fields, (index) => recordSubpatterns(parts, space.names, index));
      return fields?.map((value) => ({ ...space, fields: value })) ?? [space];
    }
    if (space.kind === 'list' && space.elements) {
      const elements = this.refineFields(space.elements, (index) => listSubpatterns(parts, space.length, index));
      return elements?.map((value) => ({ ...space, elements: value })) ?? [space];
    }
    if (space.kind !== 'type') return [space];
    const properties = this.propertyPatterns(space.type, parts);
    if (properties.size === 0) return [space];
    let products: Map<string, Space>[] = [new Map()];
    for (const [name, { type, patterns }] of properties) {
      const options = this.refine(expand(type, this.listCutoff, this.listDepth), patterns);
      if (products.length * options.length > MAX_SPACES) return [space];
      products = products.flatMap((product) => options.map((option) => new Map([...product, [name, option]])));
    }
    return products.map((properties) => ({ ...space, properties }));
  }

  private refineFields(fields: readonly Space[], patternsAt: (index: number) => Pattern[]): Space[][] | undefined {
    let products: Space[][] = [[]];
    for (const [index, field] of fields.entries()) {
      const options = this.refine([field], patternsAt(index));
      if (products.length * options.length > MAX_SPACES) return undefined;
      products = products.flatMap((product) => options.map((option) => [...product, option]));
    }
    return products;
  }

  private propertyPatterns(type: DartType, parts: Pattern[]): Map<string, { type: DartType; patterns: Pattern[] }> {
    const properties = new Map<string, { type: DartType; patterns: Pattern[] }>();
    for (const part of parts) {
      if (part.kind !== 'object') continue;
      const target = objectPatternType(this.compiler, part);
      if (!isSubtype(type, target)) continue;
      for (const field of part.fields) {
        if (!field.name) continue;
        const member = this.compiler.lookupMember(type, field.name, false);
        if (!member || member.extension) continue;
        const entry = properties.get(field.name) ?? { type: member.type, patterns: [] };
        entry.patterns.push(field.pattern);
        properties.set(field.name, entry);
      }
    }
    return properties;
  }
}

function patternAlternatives(pattern: Pattern): Pattern[] {
  switch (pattern.kind) {
    case 'parenthesized':
    case 'cast':
    case 'nullCheck':
    case 'nullAssert': {
      return patternAlternatives(pattern.pattern);
    }
    case 'or':
    case 'and': {
      return [...patternAlternatives(pattern.left), ...patternAlternatives(pattern.right)];
    }
    default: {
      return [pattern];
    }
  }
}

function recordSubpatterns(parts: Pattern[], names: (string | undefined)[], index: number): Pattern[] {
  const name = names[index];
  return parts.flatMap((part) => {
    if (part.kind !== 'record') return [];
    const field = name
      ? part.fields.find((field) => field.name === name)
      : part.fields.filter((field) => !field.name)[index];
    return field ? [field.pattern] : [];
  });
}

function listSubpatterns(parts: Pattern[], length: number, index: number): Pattern[] {
  return parts.flatMap((part) => {
    if (part.kind !== 'list') return [];
    const rest = part.elements.findIndex((element) => element.kind === 'rest');
    if (rest === -1) return part.elements[index] ? [part.elements[index] as Pattern] : [];
    const suffix = part.elements.length - rest - 1;
    const position = index < rest ? index : index >= length - suffix ? part.elements.length - (length - index) : rest;
    const element = part.elements[position];
    return element && element.kind !== 'rest' ? [element] : [];
  });
}

function spaceText(space: Space): string {
  switch (space.kind) {
    case 'constant': {
      return space.text;
    }
    case 'null': {
      return 'null';
    }
    case 'type': {
      const fields = [...(space.properties ?? [])].map(([name, value]) => `${name}: ${spaceText(value)}`);
      return `${typeToString(space.type)}(${fields.join(', ')})`;
    }
    case 'list': {
      return `List(length ${space.hasLongerLengths ? '>=' : '='} ${space.length})`;
    }
    case 'record': {
      const fields = space.fields.map((field, index) => {
        const name = space.names[index];
        return name ? `${name}: ${spaceText(field)}` : spaceText(field);
      });
      return `(${fields.join(', ')}${fields.length === 1 && !space.names[0] ? ',' : ''})`;
    }
  }
}

/** Whether Dart requires a switch statement on the type to be exhaustive. */
function isAlwaysExhaustive(type: DartType): boolean {
  const base = resolveBound(type);
  if (base.kind === 'null') return true;
  if (base.kind === 'record')
    return base.positional.every(isAlwaysExhaustive) && base.named.every((field) => isAlwaysExhaustive(field.type));
  if (base.kind !== 'interface') return false;
  const { cls } = base;
  return cls === coreTypes.bool || cls.kind === 'enum' || cls.modifiers.isSealed;
}

/** Splits a type into the spaces a switch must cover one by one. */
function expand(type: DartType, listCutoff: number, listDepth: number): Space[] {
  const base = resolveBound(type);
  if (base.kind === 'null') return [{ kind: 'null' }];
  if (base.kind === 'never' && !base.nullable) return [];
  if (base.kind === 'dynamic') {
    return [{ kind: 'type', type: interfaceType(coreTypes.object) }, { kind: 'null' }];
  }
  if (isNullable(base) && base.kind !== 'void') {
    const nonNullSpaces = expand(nonNullable(base), listCutoff, listDepth);
    return nonNullSpaces.length >= MAX_SPACES ? [{ kind: 'type', type }] : [...nonNullSpaces, { kind: 'null' }];
  }
  if (base.kind === 'record') return expandRecord(base, listCutoff, listDepth);
  if (base.kind === 'interface') return expandInterface(base, listCutoff, listDepth);
  return [{ kind: 'type', type }];
}

function expandRecord(type: DartType & { kind: 'record' }, listCutoff: number, listDepth: number): Space[] {
  const fieldTypes = [...type.positional, ...type.named.map((field) => field.type)];
  const names: (string | undefined)[] = [
    ...type.positional.map((): string | undefined => undefined),
    ...type.named.map((field) => field.name),
  ];
  let products: Space[][] = [[]];
  for (const fieldType of fieldTypes) {
    const options = expand(fieldType, listCutoff, listDepth);
    if (products.length * options.length > MAX_SPACES) return [{ kind: 'type', type }];
    products = products.flatMap((product) => options.map((option) => [...product, option]));
  }
  return products.map((fields) => ({ kind: 'record', fields, names, type }));
}

function expandInterface(base: DartType & { kind: 'interface' }, listCutoff: number, listDepth: number): Space[] {
  const { cls } = base;
  if (cls === coreTypes.bool) {
    return [
      { kind: 'constant', key: true, type: base, text: 'true' },
      { kind: 'constant', key: false, type: base, text: 'false' },
    ];
  }
  if (cls.kind === 'enum') {
    const upper = overapproximateType(base);
    const constants = enumConstants(cls).filter((member) => isSubtype(member.type, upper));
    if (constants.length > MAX_SPACES) return [{ kind: 'type', type: base }];
    return constants.map((member) => ({
      kind: 'constant',
      key: member,
      type: member.type,
      text: `${cls.name}.${member.name}`,
      subject: base,
    }));
  }
  if (cls.modifiers.isSealed) return expandSealed(base, listCutoff, listDepth);
  const list = listCutoff > 0 && listDepth > 0 ? asInstanceOf(base, coreTypes.list) : undefined;
  if (list) return expandList(base, list.args[0] ?? DYNAMIC, listCutoff, listDepth);
  return [{ kind: 'type', type: base }];
}

function expandSealed(base: DartType & { kind: 'interface' }, listCutoff: number, listDepth: number): Space[] {
  const spaces: Space[] = [];
  for (const subclass of base.cls.subclasses) {
    const subtype = subclassType(base, subclass);
    if (subclass.typeParams.length === 0 && !isSubtype(subtype, base)) continue;
    const options = expand(subtype, listCutoff, listDepth);
    if (spaces.length + options.length > MAX_SPACES) return [{ kind: 'type', type: base }];
    spaces.push(...options);
  }
  return spaces;
}

function expandList(type: DartType, elementType: DartType, cutoff: number, depth: number): Space[] {
  const options = expand(elementType, cutoff, depth - 1);
  const spaces: ListSpace[] = [];
  for (let length = 0; length <= cutoff; length++) {
    const space: ListSpace = { kind: 'list', type, elementType, length, hasLongerLengths: length === cutoff };
    if (options.length === 0 && length > 0) continue;
    if (options.length <= 1 || options.length ** length > MAX_SPACES - spaces.length - cutoff + length) {
      spaces.push(space);
      continue;
    }
    let products: Space[][] = [[]];
    for (let index = 0; index < length; index++) {
      products = products.flatMap((elements) => options.map((element) => [...elements, element]));
    }
    for (const elements of products) spaces.push({ ...space, elements });
  }
  return spaces;
}

function listLengthCutoff(patterns: Pattern[]): number {
  let cutoff = 0;
  let prefix = 0;
  let suffix = 0;
  const visit = (pattern: Pattern): void => {
    if (pattern.kind !== 'list') return;
    for (const element of pattern.elements) {
      if (element.kind !== 'rest') cutoff = Math.max(cutoff, listLengthCutoff([element]));
    }
    const rest = pattern.elements.findIndex((element) => element.kind === 'rest');
    if (rest === -1) {
      cutoff = Math.max(cutoff, pattern.elements.length + 1);
      return;
    }
    const after = pattern.elements.length - rest - 1;
    const part = pattern.elements[rest];
    const nested = part.kind === 'rest' && part.pattern ? listLengthCutoff([part.pattern]) : 0;
    prefix = Math.max(prefix, rest + nested);
    suffix = Math.max(suffix, after);
  };
  for (const pattern of patterns) visitNestedPatterns(pattern, visit);
  return Math.max(prefix + suffix, cutoff);
}

function listNesting(pattern: Pattern): number {
  let depth = 0;
  visitNestedPatterns(pattern, (part) => {
    if (part.kind !== 'list') return;
    let nested = 0;
    for (const element of part.elements) {
      const child = element.kind === 'rest' ? element.pattern : element;
      if (child) nested = Math.max(nested, listNesting(child));
    }
    depth = Math.max(depth, nested + 1);
  });
  return depth;
}

function visitNestedPatterns(pattern: Pattern, visit: (pattern: Pattern) => void): void {
  visit(pattern);
  switch (pattern.kind) {
    case 'and':
    case 'or': {
      visitNestedPatterns(pattern.left, visit);
      visitNestedPatterns(pattern.right, visit);
      break;
    }
    case 'cast':
    case 'nullAssert':
    case 'nullCheck':
    case 'parenthesized': {
      visitNestedPatterns(pattern.pattern, visit);
      break;
    }
    case 'record':
    case 'object': {
      for (const field of pattern.fields) visitNestedPatterns(field.pattern, visit);
      break;
    }
    default: {
      break;
    }
  }
}

function enumConstants(cls: ClassInfo): FieldMember[] {
  return [...cls.staticMembers.values()].filter(
    (member): member is FieldMember => member.kind === 'field' && member.isEnumValue === true
  );
}

/** A subclass's type as an instance of a sealed supertype, with type arguments matching where they can. */
function subclassType(supertype: DartType & { kind: 'interface' }, subclass: ClassInfo): DartType {
  if (subclass.typeParams.length === 0) return interfaceType(subclass);
  const path = subclass.supertypePath(supertype.cls);
  const map = new Map(subclass.typeParams.map((param) => [param, DYNAMIC as DartType]));
  if (path) {
    for (const [index, arg] of path.args.entries()) {
      if (arg.kind === 'typeParam' && map.has(arg.param)) map.set(arg.param, supertype.args[index] ?? DYNAMIC);
    }
  }
  return substitute(subclass.thisType, map);
}

/** Whether a pattern matches every value of a type. */
// code-gauge-allow functionCognitiveComplexity 29 -- One case per kind of pattern and space, as Dart decides exhaustiveness.
// code-gauge-allow functionNcss 47 -- One case per kind of pattern and space, as Dart decides exhaustiveness.
function coversAll(compiler: PatternCompiler, pattern: Pattern, type: DartType): boolean {
  const comparison = nullPatternComparison(pattern);
  if (comparison) return comparison === '==' ? isSubtype(type, NULL) : !isPotentiallyNullable(type);
  switch (pattern.kind) {
    case 'wildcard':
    case 'variable': {
      if (pattern.kind === 'variable' && !pattern.type) return true;
      if (!pattern.type) return true;
      return isSubtype(type, compiler.resolveType(pattern.type));
    }
    case 'parenthesized': {
      return coversAll(compiler, pattern.pattern, type);
    }
    case 'or': {
      return coversAll(compiler, pattern.left, type) || coversAll(compiler, pattern.right, type);
    }
    case 'and': {
      return coversAll(compiler, pattern.left, type) && coversAll(compiler, pattern.right, type);
    }
    case 'cast': {
      return coversAll(compiler, pattern.pattern, compiler.resolveType(pattern.type));
    }
    case 'nullAssert': {
      return coversAll(compiler, pattern.pattern, nonNullable(type));
    }
    case 'nullCheck': {
      return !isPotentiallyNullable(type) && coversAll(compiler, pattern.pattern, type);
    }
    case 'object': {
      const target = objectPatternType(compiler, pattern);
      if (!isSubtype(type, target) || isPotentiallyNullable(type)) return false;
      return pattern.fields.every((field) => {
        const member = field.name ? compiler.lookupMember(type, field.name, false) : undefined;
        return member ? coversAll(compiler, field.pattern, member.type) : false;
      });
    }
    case 'record': {
      const base = resolveBound(type);
      if (base.kind !== 'record' || isPotentiallyNullable(type)) return false;
      return recordFieldsCover(pattern, base, (fieldPattern, fieldType) =>
        coversAll(compiler, fieldPattern, fieldType)
      );
    }
    case 'list': {
      const base = resolveBound(type);
      if (base.kind !== 'interface' || isPotentiallyNullable(type)) return false;
      const list = asInstanceOf(base, coreTypes.list);
      return (
        !!list &&
        listCovers(compiler, pattern, {
          kind: 'list',
          type,
          elementType: list.args[0] ?? DYNAMIC,
          length: 0,
          hasLongerLengths: true,
        }) === true
      );
    }
    case 'map': {
      const base = resolveBound(type);
      return (
        base.kind === 'interface' &&
        !isPotentiallyNullable(type) &&
        asInstanceOf(base, coreTypes.map) !== undefined &&
        pattern.entries.length === 0
      );
    }
    default: {
      return false;
    }
  }
}

function objectPatternType(compiler: PatternCompiler, pattern: Extract<Pattern, { kind: 'object' }>): DartType {
  return compiler.objectPatternTypes.get(pattern) ?? compiler.resolveType(pattern.type);
}

function recordFieldsCover(
  pattern: Extract<Pattern, { kind: 'record' }>,
  type: DartType & { kind: 'record' },
  check: (pattern: Pattern, type: DartType) => boolean
): boolean {
  const positional = pattern.fields.filter((field) => field.name === undefined);
  const named = pattern.fields.filter((field) => field.name !== undefined);
  if (positional.length !== type.positional.length || named.length !== type.named.length) return false;
  return (
    positional.every((field, index) => check(field.pattern, type.positional[index])) &&
    named.every((field) => {
      const fieldType = type.named.find((other) => other.name === field.name)?.type;
      return fieldType !== undefined && check(field.pattern, fieldType);
    })
  );
}

// code-gauge-allow functionCognitiveComplexity 18 -- Match every supported kind of pattern against a value space.
// code-gauge-allow functionNcss 39 -- One case per kind of pattern and space, as Dart decides exhaustiveness.
function covers(compiler: PatternCompiler, pattern: Pattern, space: Space): Coverage {
  const comparison = nullPatternComparison(pattern);
  if (comparison)
    return comparison === '==' ? space.kind === 'null' : space.kind !== 'null' && !isPotentiallyNullable(space.type);
  switch (pattern.kind) {
    case 'parenthesized': {
      return covers(compiler, pattern.pattern, space);
    }
    case 'or':
    case 'and': {
      return combineCoverage(
        [pattern.left, pattern.right],
        (part) => covers(compiler, part, space),
        pattern.kind === 'and'
      );
    }
    case 'cast': {
      return (
        coversAll(compiler, pattern.pattern, compiler.resolveType(pattern.type)) ||
        covers(compiler, pattern.pattern, space)
      );
    }
    case 'nullAssert': {
      return space.kind === 'null' || covers(compiler, pattern.pattern, space);
    }
    case 'nullCheck': {
      return space.kind !== 'null' && covers(compiler, pattern.pattern, space);
    }
    case 'wildcard':
    case 'variable': {
      if (!pattern.type) return true;
      const tested = compiler.resolveType(pattern.type);
      if (space.kind === 'null') return isSubtype(NULL, tested);
      return spaceSubtype(space, tested);
    }
    case 'constant': {
      return constantCovers(compiler, pattern.value, space);
    }
    case 'object': {
      return objectCovers(compiler, pattern, space);
    }
    case 'record': {
      return recordCovers(compiler, pattern, space);
    }
    case 'list': {
      if (space.kind === 'list') return listCovers(compiler, pattern, space);
      return space.kind === 'type' && coversAll(compiler, pattern, space.type);
    }
    case 'map': {
      return space.kind === 'type' && coversAll(compiler, pattern, space.type);
    }
    default: {
      return false;
    }
  }
}

// code-gauge-allow functionCognitiveComplexity 18 -- Keep the prefix, middle and suffix of each list length space together.
function listCovers(
  compiler: PatternCompiler,
  pattern: Extract<Pattern, { kind: 'list' }>,
  space: ListSpace
): Coverage {
  if (pattern.typeArguments?.length === 1) {
    const requiredElement = compiler.resolveType(pattern.typeArguments[0]);
    if (!isSubtype(space.elementType, requiredElement)) return false;
  }
  const rest = pattern.elements.findIndex((element) => element.kind === 'rest');
  const fixed = pattern.elements.length - (rest !== -1 ? 1 : 0);
  if (rest !== -1 ? space.length < fixed : space.hasLongerLengths || space.length !== fixed) return false;
  return combineCoverage(
    pattern.elements.entries(),
    ([index, element]) => {
      if (element.kind === 'rest') {
        if (!element.pattern) return true;
        const length = space.length - fixed;
        return covers(compiler, element.pattern, {
          ...space,
          length,
          type: interfaceType(coreTypes.list, [space.elementType]),
          elements: space.elements?.slice(rest, rest + length),
        });
      }
      const position = rest !== -1 && index > rest ? space.length + index - pattern.elements.length : index;
      const elementSpace = space.elements?.[position];
      return elementSpace ? covers(compiler, element, elementSpace) : coversAll(compiler, element, space.elementType);
    },
    true
  );
}

function constantCovers(compiler: PatternCompiler, value: Expression, space: Space): Coverage {
  if (space.kind !== 'constant' && space.kind !== 'null') return false;
  const compiled = compiler.patternConstants.get(value);
  if (!compiled) return false;
  const type = space.kind === 'null' ? NULL : space.type;
  if (!isSubtype(type, compiled.type) && !isSubtype(compiled.type, type)) return false;
  const matches = (actual: Value): boolean => {
    if (space.kind === 'null') return actual === undefined;
    const { key } = space;
    if (typeof key === 'boolean') return actual === key;
    return actual instanceof DartObject && actual.cls === key.owner && actual.native?.name === key.name;
  };
  if (compiled.constValue) return matches(compiled.constValue.value);
  return (frame) => matches(compiled.run(frame));
}

function objectCovers(
  compiler: PatternCompiler,
  pattern: Extract<Pattern, { kind: 'object' }>,
  space: Space
): Coverage {
  if (space.kind === 'null') return false;
  const target = objectPatternType(compiler, pattern);
  if (!spaceSubtype(space, target)) return false;
  if (space.kind === 'constant' && pattern.fields.length > 0) return false;
  return combineCoverage(
    pattern.fields,
    (field) => {
      if (!field.name) return false;
      const property = space.kind === 'type' ? space.properties?.get(field.name) : undefined;
      if (property) return covers(compiler, field.pattern, property);
      const member = compiler.lookupMember(space.type, field.name, false);
      return member ? coversAll(compiler, field.pattern, member.type) : false;
    },
    true
  );
}

function spaceSubtype(space: Exclude<Space, { kind: 'null' }>, type: DartType): boolean {
  return (
    isSubtype(space.type, type) ||
    (space.kind === 'constant' && space.subject !== undefined && isSubtype(space.subject, type))
  );
}

function recordCovers(
  compiler: PatternCompiler,
  pattern: Extract<Pattern, { kind: 'record' }>,
  space: Space
): Coverage {
  if (space.kind === 'record') {
    const positional = pattern.fields.filter((field) => field.name === undefined);
    const named = pattern.fields.filter((field) => field.name !== undefined);
    const positionalCount = space.names.filter((name) => name === undefined).length;
    if (positional.length !== positionalCount || named.length !== space.names.length - positionalCount) return false;
    return combineCoverage(
      space.fields.entries(),
      ([index, fieldSpace]) => {
        const name = space.names[index];
        const field = name === undefined ? positional[index] : named.find((other) => other.name === name);
        return field !== undefined && covers(compiler, field.pattern, fieldSpace);
      },
      true
    );
  }
  if (space.kind !== 'type') return false;
  const base = resolveBound(space.type);
  return (
    base.kind === 'record' &&
    recordFieldsCover(pattern, base, (fieldPattern, fieldType) => coversAll(compiler, fieldPattern, fieldType))
  );
}
