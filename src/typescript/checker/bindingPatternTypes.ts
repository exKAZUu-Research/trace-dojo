import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { arrayLiteralLength, arrayPatternElements, named, propertyNameText } from './syntax';
import {
  anonymousObject,
  anyType,
  emptyStructure,
  freshObjectLiteral,
  isPropertyKeyLiteral,
  type ObjectType,
  type Property,
  simpleProperty,
  type TupleElement,
  type TupleInfo,
  type Type,
} from './types';

interface BindingContext {
  isConst: boolean;
  parameter: boolean;
}

const parameterContext: BindingContext = { isConst: false, parameter: true };

export function impliedPatternType(
  c: Checker,
  pattern: TreeNode,
  leafType: (element: TreeNode) => Type,
  binding?: BindingContext
): Type | undefined {
  return patternShape(
    c,
    pattern,
    (element) => {
      const initializer = binding && bindingElementDefaultType(c, element, binding);
      return (
        initializer ??
        impliedPatternType(c, defaultedTarget(element) ?? element, leafType, binding) ??
        leafType(element)
      );
    },
    binding ? (binding.parameter ? 'parameter' : 'variable') : undefined
  );
}

export function inferredPatternParameterType(c: Checker, pattern: TreeNode): Type {
  const type = patternShape(
    c,
    pattern,
    (element) => bindingElementDefaultType(c, element) ?? inferredPatternParameterType(c, element),
    'inferred'
  );
  if (type) return type;
  c.patterns.reportImplicitAny(pattern);
  return anyType;
}

export function padParameterInitializer(c: Checker, pattern: TreeNode, value: Type): Type {
  if (value.kind !== 'object') return value;
  if (pattern.type === 'array_pattern' && value.tuple) return padTupleInitializer(c, pattern, value.tuple, value);
  if (pattern.type === 'object_pattern' && value.fresh) return padObjectInitializer(c, pattern, value);
  return value;
}

function padObjectInitializer(c: Checker, pattern: TreeNode, value: ObjectType): Type {
  const structure = c.structureOf(value);
  const missing = new Map<string, Property>();
  for (const element of named(pattern)) {
    const { name, value: binding } = objectBindingEntry(c, element, true);
    if (name === undefined || structure.properties.has(name)) continue;
    const type = bindingElementDefaultType(c, binding);
    if (type) missing.set(name, simpleProperty(name, type, { optional: true }));
  }
  if (missing.size === 0) return value;
  return freshObjectLiteral(
    anonymousObject(() => ({ ...structure, properties: new Map([...structure.properties, ...missing]) }), {
      isLiteral: true,
      hasSpread: value.hasSpread,
      isUnionSpread: value.isUnionSpread,
    })
  );
}

function padTupleInitializer(c: Checker, pattern: TreeNode, tuple: TupleInfo, value: Type): Type {
  const { elements: source, readonly } = tuple;
  const length = arrayLiteralLength(pattern);
  if (source.length >= length || source.some((element) => element.rest)) return value;
  const bindings = new Map(arrayPatternElements(pattern).map(({ element, index }) => [index, element]));
  const elements = [...source];
  for (let index = elements.length; index < length; index++) {
    const element = bindings.get(index);
    if (element && isRest(element)) break;
    const type = element && bindingElementDefaultType(c, element);
    if (element && !type) c.patterns.reportImplicitAny(element);
    elements.push({ type: type ?? anyType, optional: true, rest: false });
  }
  return c.tupleType(elements, readonly);
}

function bindingElementDefaultType(
  c: Checker,
  element: TreeNode,
  { isConst, parameter }: BindingContext = parameterContext
): Type | undefined {
  const target = defaultedTarget(element);
  if (!target) return undefined;
  const value = element.childForFieldName('right');
  if (!value) return undefined;
  const contextual = c.patterns.impliedBindingType(target, isConst, parameter);
  return c.flow.probe(() =>
    c.silently(() => {
      const initial = c.patterns.initializerType(value, contextual);
      return c.literals.widenDeclared(
        parameter ? padParameterInitializer(c, target, initial) : initial,
        isConst,
        parameter
      );
    })
  );
}

type BindingPatternMode = 'parameter' | 'variable' | 'inferred';

function patternShape(
  c: Checker,
  pattern: TreeNode,
  elementType: (element: TreeNode) => Type,
  mode?: BindingPatternMode
): Type | undefined {
  switch (pattern.type) {
    case 'object':
    case 'object_pattern': {
      return objectType(c, pattern, elementType, mode);
    }
    case 'array':
    case 'array_pattern': {
      return tupleType(c, pattern, elementType, mode === 'parameter' || mode === 'inferred');
    }
    default: {
      return undefined;
    }
  }
}

function objectType(
  c: Checker,
  pattern: TreeNode,
  elementType: (element: TreeNode) => Type,
  mode: BindingPatternMode | undefined
): Type {
  const structure = emptyStructure();
  let hasDynamicKey = false;
  for (const element of named(pattern)) {
    const { name, value } = objectBindingEntry(c, element, mode !== undefined);
    if (isRest(element) || (name === undefined && !mode)) structure.stringIndex = { type: anyType, readonly: false };
    else if (name === undefined) hasDynamicKey = true;
    else
      structure.properties.set(name, simpleProperty(name, elementType(value), { optional: !!defaultedTarget(value) }));
  }
  const shape = anonymousObject(() => structure);
  if (mode && mode !== 'inferred' && !hasDynamicKey && structure.properties.size > 0) {
    c.patterns.initializerContexts.add(shape);
  }
  return shape;
}

function objectBindingEntry(
  c: Checker,
  element: TreeNode,
  parameter: boolean
): { name: string | undefined; value: TreeNode } {
  const key = element.childForFieldName('key');
  const value = key ? (element.childForFieldName('value') ?? element) : element;
  const name = key ? impliedPropertyName(c, key, parameter) : (defaultedTarget(element) ?? element).text;
  return { name, value };
}

function impliedPropertyName(c: Checker, key: TreeNode, parameter: boolean): string | undefined {
  if (!parameter || key.type !== 'computed_property_name') return propertyNameText(key);
  const { type } = c.patterns.capturePropertyKey(key);
  return isPropertyKeyLiteral(type) ? String(type.value) : undefined;
}

function tupleType(c: Checker, pattern: TreeNode, elementType: (element: TreeNode) => Type, parameter: boolean): Type {
  const entries = arrayPatternElements(pattern);
  if (parameter && (entries.length === 0 || (entries[0].index === 0 && isRest(entries[0].element))))
    return c.globalType('Iterable', [anyType]);
  const required = parameter ? lastRequiredPosition(entries) : Number.POSITIVE_INFINITY;
  const elements: TupleElement[] = [];
  for (const { element, index } of entries) {
    while (elements.length < index) elements.push({ type: anyType, optional: elements.length > required, rest: false });
    if (isRest(element)) {
      elements.push({ type: parameterRest(c, elementType(named(element)[0])), optional: false, rest: true });
      break;
    }
    elements.push({ type: elementType(element), optional: index > required, rest: false });
  }
  return c.tupleType(elements);
}

function lastRequiredPosition(entries: ReturnType<typeof arrayPatternElements>): number {
  return entries.findLast(({ element }) => !isRest(element) && !defaultedTarget(element))?.index ?? -1;
}

function parameterRest(c: Checker, inferred: Type): Type {
  return inferred.kind === 'object' && c.isArrayOrTuple(inferred) ? inferred : c.arrayType(anyType);
}

function isRest(element: TreeNode): boolean {
  return element.type === 'spread_element' || element.type === 'rest_pattern';
}

export function defaultedTarget(element: TreeNode): TreeNode | undefined {
  return ['assignment_expression', 'assignment_pattern', 'object_assignment_pattern'].includes(element.type)
    ? (element.childForFieldName('left') ?? undefined)
    : undefined;
}
