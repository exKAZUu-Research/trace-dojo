import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { arrayPatternElements, named, propertyNameText } from './syntax';
import {
  anonymousObject,
  anyType,
  emptyStructure,
  freshObjectLiteral,
  isPropertyKeyLiteral,
  mapType,
  type ObjectType,
  type Property,
  simpleProperty,
  type TupleElement,
  type TupleInfo,
  type Type,
} from './types';

export function impliedPatternType(
  c: Checker,
  pattern: TreeNode,
  leafType: (element: TreeNode) => Type
): Type | undefined {
  return patternShape(
    c,
    pattern,
    (element) => impliedPatternType(c, defaultedTarget(element) ?? element, leafType) ?? leafType(element)
  );
}

export function inferredPatternParameterType(
  c: Checker,
  pattern: TreeNode,
  implicitAny: (element: TreeNode) => void
): Type {
  const type = patternShape(c, pattern, (element) => inferParameterElement(c, element, implicitAny), true);
  if (type) return type;
  implicitAny(pattern);
  return anyType;
}

export function applyParameterPattern(
  c: Checker,
  pattern: TreeNode,
  value: Type,
  implied: Type | undefined,
  nested = true
): Type {
  if (!implied || implied.kind !== 'object') return value;
  const project = (member: Type): Type => {
    if (member.kind !== 'object') return member;
    if (pattern.type === 'array_pattern' && member.tuple && implied.tuple)
      return tupleInitializer(c, pattern, member.tuple, implied.tuple, nested);
    if (pattern.type === 'object_pattern' && member.fresh)
      return objectInitializer(c, pattern, member, implied, nested);
    return member;
  };
  return nested ? mapType(value, project) : project(value);
}

function objectInitializer(
  c: Checker,
  pattern: TreeNode,
  value: ObjectType,
  implied: ObjectType,
  nested: boolean
): Type {
  const structure = c.structureOf(value);
  const properties = new Map(structure.properties);
  const expected = c.structureOf(implied).properties;
  for (const [name, property] of expected) {
    if (property.optional) properties.set(name, { ...(properties.get(name) ?? property), optional: true });
  }
  if (nested) projectNestedProperties(c, pattern, properties, expected);
  return freshObjectLiteral(anonymousObject(() => ({ ...structure, properties }), { isLiteral: true }));
}

function projectNestedProperties(
  c: Checker,
  pattern: TreeNode,
  properties: Map<string, Property>,
  expected: Map<string, Property>
): void {
  for (const element of named(pattern)) {
    if (element.type !== 'pair_pattern') continue;
    const key = element.childForFieldName('key') as TreeNode;
    const pattern = element.childForFieldName('value') as TreeNode;
    const nested = defaultedTarget(pattern) ?? pattern;
    if (!isBindingPattern(nested)) continue;
    const name = impliedPropertyName(c, key, true);
    const actual = name === undefined ? undefined : properties.get(name);
    if (!actual) continue;
    properties.set(actual.name, {
      ...actual,
      type: () => applyParameterPattern(c, nested, actual.type(), expected.get(actual.name)?.type()),
    });
  }
}

function tupleInitializer(c: Checker, pattern: TreeNode, value: TupleInfo, implied: TupleInfo, nested: boolean): Type {
  const entries = nested ? arrayPatternElements(pattern) : [];
  const elements = [...value.elements];
  if (value.elements.some((element) => element.rest)) return c.tupleType(elements, value.readonly);
  for (const { element, index } of entries) {
    const actual = elements[index];
    const nested = defaultedTarget(element) ?? element;
    if (actual && isBindingPattern(nested))
      elements[index] = {
        ...actual,
        type: applyParameterPattern(c, nested, actual.type, implied.elements[index]?.type),
      };
  }
  if (elements.length > lastRequiredPosition(entries)) {
    for (const element of implied.elements.slice(elements.length))
      if (!element.rest) elements.push({ ...element, optional: true });
  }
  return c.tupleType(elements, value.readonly);
}

function isBindingPattern(node: TreeNode): boolean {
  return node.type === 'object_pattern' || node.type === 'array_pattern';
}

function inferParameterElement(c: Checker, element: TreeNode, implicitAny: (element: TreeNode) => void): Type {
  const target = defaultedTarget(element);
  const value = target && element.childForFieldName('right');
  if (!value) return inferredPatternParameterType(c, element, implicitAny);
  const contextual = c.patterns.impliedType(target);
  return c.flow.probe(() =>
    c.silently(() => {
      const initial = c.patterns.initializerType(value, contextual);
      return c.literals.widenDeclared(applyParameterPattern(c, target, initial, contextual), false);
    })
  );
}

function patternShape(
  c: Checker,
  pattern: TreeNode,
  elementType: (element: TreeNode) => Type,
  parameter = false
): Type | undefined {
  switch (pattern.type) {
    case 'object':
    case 'object_pattern': {
      return objectType(c, pattern, elementType, parameter);
    }
    case 'array':
    case 'array_pattern': {
      return tupleType(c, pattern, elementType, parameter);
    }
    default: {
      return undefined;
    }
  }
}

function objectType(c: Checker, pattern: TreeNode, elementType: (element: TreeNode) => Type, parameter: boolean): Type {
  const structure = emptyStructure();
  for (const element of named(pattern)) {
    const isPair = element.type === 'pair' || element.type === 'pair_pattern';
    const value = isPair ? (element.childForFieldName('value') as TreeNode) : element;
    const key = isPair ? element.childForFieldName('key') : undefined;
    const name = key ? impliedPropertyName(c, key, parameter) : (defaultedTarget(element) ?? element).text;
    if (isRest(element) || (name === undefined && !parameter))
      structure.stringIndex = { type: anyType, readonly: false };
    else if (name !== undefined)
      structure.properties.set(name, simpleProperty(name, elementType(value), { optional: !!defaultedTarget(value) }));
  }
  return anonymousObject(() => structure);
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
