import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import { takesNoArguments } from './callArity';
import type { Checker } from './checker';
import { newInferenceRun } from './inference';
import { hasToken, isConstructorName, named, propertyNameText } from './syntax';
import {
  anonymousObject,
  anyType,
  type ClassInfo,
  emptyStructure,
  functionType,
  intersectionOf,
  isAnyLike,
  isIntrinsic,
  isTemplateOrStringMapping,
  literalType,
  type Signature,
  simpleProperty,
  stringType,
  symbolType,
  type Type,
  typeMembers,
  undefinedType,
  unionOf,
  voidType,
} from './types';

type DecoratedKind = 'class' | 'method' | 'getter' | 'setter' | 'field' | 'accessor';

const genericKeyKinds = new Set(['typeParameter', 'indexedAccess', 'conditional', 'keyof']);

const contextTypeNames: Record<DecoratedKind, string> = {
  class: 'ClassDecoratorContext',
  method: 'ClassMethodDecoratorContext',
  getter: 'ClassGetterDecoratorContext',
  setter: 'ClassSetterDecoratorContext',
  field: 'ClassFieldDecoratorContext',
  accessor: 'ClassAccessorDecoratorContext',
};

const failureMessages: Record<DecoratedKind, string> = {
  class: 'クラスのデコレーターを式として呼び出すときのシグネチャを解決できません。',
  method: 'メソッドのデコレーターを式として呼び出すときのシグネチャを解決できません。',
  getter: 'メソッドのデコレーターを式として呼び出すときのシグネチャを解決できません。',
  setter: 'メソッドのデコレーターを式として呼び出すときのシグネチャを解決できません。',
  field: 'プロパティのデコレーターを式として呼び出すときのシグネチャを解決できません。',
  accessor: 'プロパティのデコレーターを式として呼び出すときのシグネチャを解決できません。',
};

/**
 * Checks the decorators of a class and its members as tsc checks TypeScript's standard decorators: each is called with
 * what it decorates and a context object of the kind of member it decorates.
 */
export function checkDecorators(c: Checker, classNode: TreeNode, info: ClassInfo): void {
  const classType = c.classes.valueTypeOf(info);
  const classContext = c.globalType('ClassDecoratorContext', [classType]);
  for (const decorator of decoratorsOf(classNode))
    checkDecorator(c, decorator, 'class', [classType, classContext], classType);
  for (const member of named(classNode.childForFieldName('body') ?? classNode)) {
    const decorators = decoratorsOf(member);
    if (decorators.length === 0) continue;
    const kind = memberKind(member);
    const nameNode = member.childForFieldName('name');
    if (!kind || !nameNode) continue;
    const isStatic = hasToken(member, 'static');
    const thisType = isStatic ? classType : c.classes.selfType(info);
    const owner = isStatic ? info.staticType : info.instanceType;
    const valueType = c.structureOf(owner).properties.get(c.classes.propertyKey(nameNode, nameNode))?.type() ?? anyType;
    const context = memberContextType(c, kind, [thisType, valueType], {
      name: contextNameType(c, nameNode),
      isPrivate: nameNode.type === 'private_property_identifier',
      isStatic,
    });
    const decorated = decoratedValue(c, kind, thisType, valueType);
    const replacement = replacementType(c, kind, thisType, valueType, decorated);
    for (const decorator of decorators) checkDecorator(c, decorator, kind, [decorated, context], replacement);
  }
}

/** What a standard decorator may decorate, besides a member of a class body that runs. */
const decoratedDeclarations = new Set(['class_declaration', 'class', 'abstract_class_declaration']);

/**
 * Reports each decorator on something other than a class or a class member that runs, such as a parameter, which tsc
 * rejects because standard decorators do not apply there.
 */
export function checkDecoratorPlacements(c: Checker, root: TreeNode): void {
  for (const decorator of root.descendantsOfType('decorator'))
    if (decorator && !isDecoratable(decorator.parent)) c.error(decorator, 'デコレーターはここでは無効です。');
}

function isDecoratable(node: TreeNode | null): boolean {
  if (!node) return false;
  if (decoratedDeclarations.has(node.type)) return true;
  return (
    node.parent?.type === 'class_body' &&
    memberKind(node) !== undefined &&
    !isConstructorName(node.childForFieldName('name')) &&
    !hasToken(node, 'declare') &&
    !hasToken(node, 'abstract')
  );
}

function decoratorsOf(node: TreeNode): TreeNode[] {
  return named(node).filter((child) => child.type === 'decorator');
}

function memberKind(member: TreeNode): DecoratedKind | undefined {
  if (member.type === 'field_definition') return hasToken(member, 'accessor') ? 'accessor' : 'field';
  if (member.type !== 'method_definition') return undefined;
  if (hasToken(member, 'get')) return 'getter';
  return hasToken(member, 'set') ? 'setter' : 'method';
}

/** What a decorator of a member receives first: the method, an accessor function, or the auto-accessor's pair. */
function decoratedValue(c: Checker, kind: DecoratedKind, thisType: Type, valueType: Type): Type {
  switch (kind) {
    case 'getter': {
      return functionType({ typeParameters: [], parameters: [], thisType, returnType: () => valueType });
    }
    case 'setter': {
      return functionType({
        typeParameters: [],
        parameters: [{ name: 'value', type: valueType, optional: false, rest: false }],
        thisType,
        returnType: () => voidType,
      });
    }
    case 'accessor': {
      return c.globalType('ClassAccessorDecoratorTarget', [thisType, valueType]);
    }
    case 'field': {
      return undefinedType;
    }
    default: {
      return valueType;
    }
  }
}

/** What a decorator of a member may return in place of what it decorates. */
function replacementType(c: Checker, kind: DecoratedKind, thisType: Type, valueType: Type, decorated: Type): Type {
  if (kind === 'accessor') return c.globalType('ClassAccessorDecoratorResult', [thisType, valueType]);
  if (kind !== 'field') return decorated;
  return functionType({
    typeParameters: [],
    parameters: [{ name: 'value', type: valueType, optional: false, rest: false }],
    thisType,
    returnType: () => valueType,
  });
}

/** The context a member decorator receives: the library's context type, with its resolved key and placement. */
function memberContextType(
  c: Checker,
  kind: DecoratedKind,
  typeArguments: Type[],
  member: { name: Type; isPrivate: boolean; isStatic: boolean }
): Type {
  const context = c.globalType(contextTypeNames[kind], typeArguments);
  const literals = anonymousObject(() => {
    const structure = emptyStructure();
    structure.properties.set('name', simpleProperty('name', member.name, { readonly: true }));
    structure.properties.set('private', simpleProperty('private', literalType(member.isPrivate), { readonly: true }));
    structure.properties.set('static', simpleProperty('static', literalType(member.isStatic), { readonly: true }));
    return structure;
  });
  return intersectionOf([context, literals], c);
}

function contextNameType(c: Checker, nameNode: TreeNode): Type {
  if (nameNode.type !== 'computed_property_name') {
    return literalType(propertyNameText(nameNode) ?? nameNode.text);
  }
  const inner = named(nameNode)[0];
  if (!inner) return unionOf([stringType, symbolType]);
  return computedKeyNameType(
    c,
    c.silently(() => c.expressions.check(inner))
  );
}

function computedKeyNameType(c: Checker, keyType: Type): Type {
  if (isAnyLike(keyType)) return unionOf([stringType, symbolType]);
  return unionOf(typeMembers(keyType).map((member) => computedKeyMemberType(c, member)));
}

function computedKeyMemberType(c: Checker, member: Type): Type {
  if (member.kind === 'literal') return typeof member.value === 'symbol' ? member : literalType(String(member.value));
  if (isIntrinsic(member, 'symbol')) return symbolType;
  if (isTemplateOrStringMapping(member)) return member;
  if (!genericKeyKinds.has(member.kind)) return stringType;
  const bound = c.baseConstraint(member);
  return bound !== member ? computedKeyNameType(c, bound) : unionOf([stringType, symbolType]);
}

/** Checks one decorator, called with `args`, which must fit one of its call signatures. */
function checkDecorator(c: Checker, decorator: TreeNode, kind: DecoratedKind, args: Type[], replacement: Type): void {
  const expression = named(decorator)[0];
  if (!expression) return;
  const type = c.expressions.check(expression);
  if (isAnyLike(type)) return;
  const signatures = c.signaturesOf(type, 'call');
  // A decorator factory such as `() => (value, context) => {}` written without its call takes no parameter.
  if (takesNoArguments(signatures)) {
    c.error(
      expression,
      `'${expression.text}' は受け入れる引数が少なすぎるので、ここでデコレーターとして使用することができません。最初にこれを呼び出してから、'@${expression.text}()' を書き込むつもりでしたか?`
    );
    return;
  }
  const fitting = signatures.map((signature) => fit(c, signature, args)).find(Boolean);
  if (!fitting) {
    c.error(expression, failureMessages[kind]);
    return;
  }
  const returned = fitting.returnType();
  const expected = unionOf([voidType, replacement]);
  if (!isAnyLike(returned) && !c.relations.isAssignable(returned, expected))
    c.error(
      expression,
      `デコレーター関数の戻り値の型 '${c.print(returned)}' を型 '${c.print(expected)}' に代入することはできません。`
    );
}

/** The signature, instantiated for `args`, when they fit it. */
function fit(c: Checker, signature: Signature, args: Type[]): Signature | undefined {
  const required = signature.parameters.filter((parameter) => !parameter.optional && !parameter.rest).length;
  if (required > args.length) return undefined;
  let instantiated = signature;
  if (signature.typeParameters.length > 0) {
    const run = newInferenceRun(signature.typeParameters);
    for (const [index, arg] of args.entries()) {
      const parameter = parameterAt(c, signature, index);
      if (parameter) c.inference.inferArgument(run, arg, parameter);
    }
    instantiated = c.instantiateSignature(
      signature,
      c.inference.finalMapper(signature, signature.typeParameters, run.inferences)
    );
  }
  const fits = args.every((arg, index) => {
    const parameter = parameterAt(c, instantiated, index);
    return parameter === undefined || c.relations.isAssignable(arg, parameter);
  });
  return fits ? instantiated : undefined;
}

function parameterAt(c: Checker, signature: Signature, index: number): Type | undefined {
  const parameter = signature.parameters[Math.min(index, signature.parameters.length - 1)];
  if (!parameter) return undefined;
  if (parameter.rest) return c.restElementType(parameter.type);
  return index < signature.parameters.length ? parameter.type : undefined;
}
