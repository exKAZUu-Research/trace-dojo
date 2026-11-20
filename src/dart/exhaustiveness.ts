import type { Expression, Pattern, Span } from './ast';
import type { ClassInfo, Member } from './classes';
import type { ExpressionCompiler } from './expressionCompiler';
import {
  asInstanceOf,
  coreTypes,
  type DartType,
  DYNAMIC,
  interfaceType,
  isNullable,
  isSubtype,
  nonNullable,
  NULL,
  resolveBound,
  substitute,
  typeToString,
} from './types';

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
  | { kind: 'constant'; key: unknown; type: DartType; text: string }
  | { kind: 'null' }
  | { kind: 'type'; type: DartType }
  | { kind: 'record'; fields: Space[]; names: (string | undefined)[]; type: DartType };

const MAX_SPACES = 256;

/**
 * Whether the patterns (of cases without guards) cover every value of `type`. A switch expression, or a switch
 * statement on a type Dart requires to be covered (bool, enums, sealed classes, and records and nullable types of
 * them), is rejected when they do not.
 */
export function checkExhaustive(
  compiler: ExpressionCompiler,
  type: DartType,
  patterns: Pattern[],
  span: Span,
  isStatement: boolean
): boolean {
  if (patterns.some((pattern) => coversAll(compiler, pattern, type))) return true;
  const cutoff = Math.min(MAX_SPACES - 1, listLengthCutoff(patterns));
  const spaces = expand(type, cutoff);
  const missing = spaces.find((space) => !patterns.some((pattern) => covers(compiler, pattern, space)));
  if (!missing) return true;
  if (isStatement && !isAlwaysExhaustive(type)) return false;
  compiler.error(
    span,
    `switch が ${typeToString(type)} 型のすべての値を扱っていません（${spaceText(missing)} の場合がありません）。`
  );
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
      return `${typeToString(space.type)}()`;
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
  if (type.kind === 'null') return true;
  const base = resolveBound(type);
  if (base.kind === 'record')
    return base.positional.every(isAlwaysExhaustive) && base.named.every((field) => isAlwaysExhaustive(field.type));
  if (base.kind !== 'interface') return false;
  const { cls } = base;
  return cls === coreTypes.bool || cls.kind === 'enum' || cls.modifiers.isSealed;
}

/** Splits a type into the spaces a switch must cover one by one. */
function expand(type: DartType, listCutoff: number): Space[] {
  if (type.kind === 'null') return [{ kind: 'null' }];
  if (type.kind === 'never' && !type.nullable) return [];
  if (type.kind === 'dynamic') {
    return [{ kind: 'type', type: interfaceType(coreTypes.object) }, { kind: 'null' }];
  }
  if (isNullable(type) && type.kind !== 'void') {
    const nonNullSpaces = expand(nonNullable(type), listCutoff);
    return nonNullSpaces.length >= MAX_SPACES ? [{ kind: 'type', type }] : [...nonNullSpaces, { kind: 'null' }];
  }
  const base = resolveBound(type);
  if (base.kind === 'record') return expandRecord(base, listCutoff);
  if (base.kind === 'interface') return expandInterface(base, listCutoff);
  return [{ kind: 'type', type }];
}

function expandRecord(type: DartType & { kind: 'record' }, listCutoff: number): Space[] {
  const fieldTypes = [...type.positional, ...type.named.map((field) => field.type)];
  const names: (string | undefined)[] = [
    ...type.positional.map((): string | undefined => undefined),
    ...type.named.map((field) => field.name),
  ];
  let products: Space[][] = [[]];
  for (const fieldType of fieldTypes) {
    const options = expand(fieldType, listCutoff);
    if (products.length * options.length > MAX_SPACES) return [{ kind: 'type', type }];
    products = products.flatMap((product) => options.map((option) => [...product, option]));
  }
  return products.map((fields) => ({ kind: 'record', fields, names, type }));
}

function expandInterface(base: DartType & { kind: 'interface' }, listCutoff: number): Space[] {
  const { cls } = base;
  if (cls === coreTypes.bool) {
    return [
      { kind: 'constant', key: true, type: base, text: 'true' },
      { kind: 'constant', key: false, type: base, text: 'false' },
    ];
  }
  if (cls.kind === 'enum') {
    const constants = enumConstants(cls);
    if (constants.length > MAX_SPACES) return [{ kind: 'type', type: base }];
    return constants.map((member) => ({
      kind: 'constant',
      key: member,
      type: base,
      text: `${cls.name}.${member.name}`,
    }));
  }
  if (cls.modifiers.isSealed) {
    const spaces: Space[] = [];
    for (const subclass of cls.subclasses) {
      const options = expand(subclassType(base, subclass), listCutoff);
      if (spaces.length + options.length > MAX_SPACES) return [{ kind: 'type', type: base }];
      spaces.push(...options);
    }
    return spaces;
  }
  const list = listCutoff > 0 ? asInstanceOf(base, coreTypes.list) : undefined;
  if (list) return expandList(base, list.args[0] ?? DYNAMIC, listCutoff);
  return [{ kind: 'type', type: base }];
}

function expandList(type: DartType, elementType: DartType, cutoff: number): Space[] {
  const options = expand(elementType, 0);
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

function enumConstants(cls: ClassInfo): Member[] {
  return [...cls.staticMembers.values()].filter(
    (member) => member.kind === 'field' && (member as { isEnumValue?: boolean }).isEnumValue === true
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
// code-gauge-allow functionCognitiveComplexity 27 -- One case per kind of pattern and space, as Dart decides exhaustiveness.
// code-gauge-allow functionNcss 44 -- One case per kind of pattern and space, as Dart decides exhaustiveness.
function coversAll(compiler: ExpressionCompiler, pattern: Pattern, type: DartType): boolean {
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
      return !isNullable(type) && coversAll(compiler, pattern.pattern, type);
    }
    case 'object': {
      const target = compiler.resolveType(pattern.type, { allowRaw: true });
      if (!isSubtype(nonNullable(type), withDynamicArgs(target)) || isNullable(type)) return false;
      return pattern.fields.every((field) => {
        const member = field.name ? compiler.lookupMember(type, field.name, false) : undefined;
        return member ? coversAll(compiler, field.pattern, member.type) : false;
      });
    }
    case 'record': {
      const base = resolveBound(type);
      if (base.kind !== 'record' || isNullable(type)) return false;
      return recordFieldsCover(compiler, pattern, base, (fieldPattern, fieldType) =>
        coversAll(compiler, fieldPattern, fieldType)
      );
    }
    case 'list': {
      const base = resolveBound(type);
      if (base.kind !== 'interface' || isNullable(type)) return false;
      const list = asInstanceOf(base, coreTypes.list);
      return (
        !!list &&
        listCovers(compiler, pattern, {
          kind: 'list',
          type,
          elementType: list.args[0] ?? DYNAMIC,
          length: 0,
          hasLongerLengths: true,
        })
      );
    }
    case 'map': {
      const base = resolveBound(type);
      return (
        base.kind === 'interface' &&
        !isNullable(type) &&
        asInstanceOf(base, coreTypes.map) !== undefined &&
        pattern.entries.length === 0
      );
    }
    default: {
      return false;
    }
  }
}

function withDynamicArgs(type: DartType): DartType {
  if (type.kind === 'interface' && type.args.length === 0 && type.cls.typeParams.length > 0) {
    return interfaceType(
      type.cls,
      type.cls.typeParams.map(() => DYNAMIC)
    );
  }
  return type;
}

function recordFieldsCover(
  compiler: ExpressionCompiler,
  pattern: Extract<Pattern, { kind: 'record' }>,
  type: DartType & { kind: 'record' },
  check: (pattern: Pattern, type: DartType) => boolean
): boolean {
  void compiler;
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

// code-gauge-allow functionNcss 36 -- One case per kind of pattern and space, as Dart decides exhaustiveness.
function covers(compiler: ExpressionCompiler, pattern: Pattern, space: Space): boolean {
  switch (pattern.kind) {
    case 'parenthesized': {
      return covers(compiler, pattern.pattern, space);
    }
    case 'or': {
      return covers(compiler, pattern.left, space) || covers(compiler, pattern.right, space);
    }
    case 'and': {
      return covers(compiler, pattern.left, space) && covers(compiler, pattern.right, space);
    }
    case 'cast': {
      return (
        covers(compiler, pattern.pattern, space) ||
        coversAll(compiler, pattern.pattern, compiler.resolveType(pattern.type))
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
      if (space.kind === 'null') return isNullable(tested);
      return isSubtype(space.type, tested);
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
  compiler: ExpressionCompiler,
  pattern: Extract<Pattern, { kind: 'list' }>,
  space: ListSpace
): boolean {
  if (pattern.typeArguments?.length === 1) {
    const requiredElement = compiler.resolveType(pattern.typeArguments[0]);
    if (!isSubtype(space.elementType, requiredElement)) return false;
  }
  const rest = pattern.elements.findIndex((element) => element.kind === 'rest');
  const fixed = pattern.elements.length - (rest !== -1 ? 1 : 0);
  if (rest !== -1 ? space.length < fixed : space.hasLongerLengths || space.length !== fixed) return false;
  return pattern.elements.every((element, index) => {
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
  });
}

function constantCovers(compiler: ExpressionCompiler, value: Expression, space: Space): boolean {
  if (space.kind === 'null') return value.kind === 'null';
  if (space.kind !== 'constant') return false;
  if (value.kind === 'dotShorthand' && space.type.kind === 'interface') {
    return space.type.cls.staticMembers.get(value.name) === space.key;
  }
  return constantKey(compiler, value) === space.key;
}

function objectCovers(
  compiler: ExpressionCompiler,
  pattern: Extract<Pattern, { kind: 'object' }>,
  space: Space
): boolean {
  if (space.kind === 'null') return false;
  const target = withDynamicArgs(compiler.resolveType(pattern.type, { allowRaw: true }));
  if (!isSubtype(space.type, target)) return false;
  if (space.kind === 'constant' && pattern.fields.length > 0) return false;
  return pattern.fields.every((field) => {
    const member = field.name ? compiler.lookupMember(space.type, field.name, false) : undefined;
    return member ? coversAll(compiler, field.pattern, member.type) : false;
  });
}

function recordCovers(
  compiler: ExpressionCompiler,
  pattern: Extract<Pattern, { kind: 'record' }>,
  space: Space
): boolean {
  if (space.kind === 'record') {
    const positional = pattern.fields.filter((field) => field.name === undefined);
    const named = pattern.fields.filter((field) => field.name !== undefined);
    const positionalCount = space.names.filter((name) => name === undefined).length;
    if (positional.length !== positionalCount || named.length !== space.names.length - positionalCount) return false;
    return space.fields.every((fieldSpace, index) => {
      const name = space.names[index];
      const field = name === undefined ? positional[index] : named.find((other) => other.name === name);
      return field !== undefined && covers(compiler, field.pattern, fieldSpace);
    });
  }
  if (space.kind !== 'type') return false;
  const base = resolveBound(space.type);
  return (
    base.kind === 'record' &&
    recordFieldsCover(compiler, pattern, base, (fieldPattern, fieldType) =>
      coversAll(compiler, fieldPattern, fieldType)
    )
  );
}

/** The identity of a constant that a space of a bool or an enum names, for comparing it with a constant pattern. */
function constantKey(compiler: ExpressionCompiler, expression: Expression): unknown {
  switch (expression.kind) {
    case 'bool': {
      return expression.value;
    }
    case 'null': {
      return NULL;
    }
    case 'parenthesized': {
      return constantKey(compiler, expression.expression);
    }
    case 'identifier': {
      const resolution = compiler.resolveName(expression.name);
      if (resolution?.kind === 'staticMember') return resolution.member;
      if (resolution?.kind === 'declaration' && resolution.declaration.kind === 'variable')
        return resolution.declaration.global;
      return undefined;
    }
    case 'member': {
      if (expression.object.kind !== 'identifier') return undefined;
      const resolution = compiler.resolveName(expression.object.name);
      if (resolution?.kind === 'declaration' && resolution.declaration.kind === 'class') {
        return resolution.declaration.cls.staticMembers.get(expression.name);
      }
      return undefined;
    }
    case 'dotShorthand': {
      return { dotShorthand: expression.name };
    }
    default: {
      return undefined;
    }
  }
}
