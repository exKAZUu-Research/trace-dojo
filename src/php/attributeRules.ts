import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import type { AttributeAst, ClassDecl, Expr } from './ast';
import { lower } from './bytes';
import type { TypeDecl } from './values';

/** What an attribute list is written on, named as PHP's messages name it. */
export type AttributeTarget =
  | 'class'
  | 'function'
  | 'method'
  | 'property'
  | 'class constant'
  | 'parameter'
  | 'constant';

/** The declaration an attribute list belongs to, for the checks PHP's builtin attributes make. */
export interface AttributeSubject {
  targets: AttributeTarget[];
  cls?: Pick<ClassDecl, 'kind' | 'name' | 'isAbstract' | 'isReadonly'>;
  returnType?: TypeDecl;
}

const ALL_TARGETS: AttributeTarget[] = [
  'class',
  'function',
  'method',
  'property',
  'class constant',
  'parameter',
  'constant',
];

/** The builtin attributes by lower-case name, with their spelling and the targets PHP allows. */
const BUILTIN_ATTRIBUTES = new Map<string, { name: string; targets: AttributeTarget[] }>(
  (
    [
      ['Attribute', ['class']],
      ['ReturnTypeWillChange', ['method']],
      ['AllowDynamicProperties', ['class']],
      ['SensitiveParameter', ['parameter']],
      ['Override', ['method', 'property']],
      ['Deprecated', ['class', 'function', 'method', 'class constant', 'constant']],
      ['NoDiscard', ['function', 'method']],
      ['DelayedTargetValidation', ALL_TARGETS],
    ] as const
  ).map(([name, targets]) => [lower(name), { name, targets: [...targets] }])
);

/** Reads an attribute list, with the converter resolving class names and converting constant expressions. */
export function readAttributes(
  list: Node,
  convert: { className: (node: Node) => string; constant: (node: Node) => Expr }
): AttributeAst[] {
  return list.descendantsOfType('attribute').map((attribute) => {
    const nameNode = attribute.namedChildren.find((child) => child.type !== 'comment') as Node;
    const argumentsNode = attribute.childForFieldName('parameters');
    return {
      name: convert.className(nameNode),
      args: argumentsNode ? readArguments(argumentsNode, convert.constant) : [],
      row: attribute.startPosition.row,
    };
  });
}

function readArguments(node: Node, constant: (node: Node) => Expr): AttributeAst['args'] {
  const args: AttributeAst['args'] = [];
  const names = new Set<string>();
  for (const child of node.namedChildren) {
    if (child.type !== 'argument') continue;
    const nameNode = child.childForFieldName('name');
    const valueNode = child.namedChildren.findLast(
      (part) => part.id !== nameNode?.id && part.type !== 'comment'
    ) as Node;
    if (valueNode.type === 'variadic_unpacking') fail(child, 'Cannot use unpacking in attribute argument list');
    const name = nameNode?.text;
    if (name === undefined && args.at(-1)?.name !== undefined)
      fail(child, 'Cannot use positional argument after named argument');
    if (name !== undefined) {
      if (names.has(name)) fail(child, `Duplicate named parameter $${name}`);
      names.add(name);
    }
    args.push({ name, value: constant(valueNode) });
  }
  return args;
}

function fail(node: Node, message: string): never {
  throw new CompileError([{ row: node.startPosition.row, message }]);
}

/** The builtin attribute an attribute names, by its spelling in PHP's messages. */
export function builtinAttributeName(attribute: AttributeAst): string | undefined {
  return BUILTIN_ATTRIBUTES.get(lower(attribute.name))?.name;
}

export function hasAttribute(attributes: readonly AttributeAst[] | undefined, name: string): boolean {
  return attributes?.some((attribute) => builtinAttributeName(attribute) === name) ?? false;
}

export function findAttribute(attributes: readonly AttributeAst[] | undefined, name: string): AttributeAst | undefined {
  return attributes?.find((attribute) => builtinAttributeName(attribute) === name);
}

/** The message of the compile-time error PHP reports for builtin attributes on a declaration, if any. */
export function attributeError(attributes: readonly AttributeAst[], subject: AttributeSubject): string | undefined {
  const delayed = hasAttribute(attributes, 'DelayedTargetValidation');
  const seen = new Set<string>();
  for (const attribute of attributes) {
    const name = builtinAttributeName(attribute);
    if (!name) continue;
    const allowed = BUILTIN_ATTRIBUTES.get(lower(name))?.targets ?? [];
    if (!delayed && !subject.targets.some((target) => allowed.includes(target)))
      return `Attribute "${name}" cannot target ${subject.targets[0]} (allowed targets: ${allowed.join(', ')})`;
    if (seen.has(name)) return `Attribute "${name}" must not be repeated`;
    seen.add(name);
    if (delayed && !subject.targets.some((target) => allowed.includes(target))) continue;
    const error = validatorError(name, subject);
    if (error) return error;
  }
  return undefined;
}
function validatorError(name: string, subject: AttributeSubject): string | undefined {
  const cls = subject.cls;
  if (cls && subject.targets.includes('class')) return classValidatorError(name, cls);
  if (name === 'NoDiscard' && subject.returnType?.k === 'named') {
    const type = subject.returnType.name;
    if (type === 'void')
      return String.raw`A void function does not return a value, but #[\NoDiscard] requires a return value`;
    if (type === 'never')
      return String.raw`A never returning function does not return a value, but #[\NoDiscard] requires a return value`;
  }
  return undefined;
}

function classValidatorError(name: string, cls: NonNullable<AttributeSubject['cls']>): string | undefined {
  const kindName = cls.kind === 'class' ? (cls.isReadonly ? 'readonly class' : 'class') : cls.kind;
  if (name === 'Attribute' && cls.kind !== 'class') return `Cannot apply #[\\Attribute] to ${cls.kind} ${cls.name}`;
  if (name === 'Attribute' && cls.isAbstract) return `Cannot apply #[\\Attribute] to abstract class ${cls.name}`;
  if (name === 'AllowDynamicProperties' && (cls.kind !== 'class' || cls.isReadonly))
    return `Cannot apply #[\\AllowDynamicProperties] to ${kindName} ${cls.name}`;
  if (name === 'Deprecated' && cls.kind !== 'trait') return `Cannot apply #[\\Deprecated] to ${kindName} ${cls.name}`;
  return undefined;
}
