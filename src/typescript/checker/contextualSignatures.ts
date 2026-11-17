import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker, Mapper } from './checker';
import { named } from './syntax';
import { intersectionOf, isAnyLike, type Signature, type Type, unionOf, unknownType } from './types';

/**
 * The contextual signature a function expression gets from its contextual type: of a union, the one its members'
 * signatures share when their parameters are identical, returning what any of them returns.
 */
export function contextualSignatureOf(c: Checker, contextual: Type | undefined, node: TreeNode): Signature | undefined {
  if (!contextual) return undefined;
  if (contextual.kind !== 'union') return contextualCallSignature(c, contextual, node);
  const signatures: Signature[] = [];
  for (const member of contextual.types) {
    const signature = contextualCallSignature(c, member, node);
    if (!signature) continue;
    if (signatures.length > 0 && !haveIdenticalParameters(c, signatures[0], signature)) return undefined;
    signatures.push(signature);
  }
  if (signatures.length < 2) return signatures[0];
  return { ...signatures[0], returnType: () => unionOf(signatures.map((signature) => signature.returnType())) };
}

/**
 * The signature a type gives a function expression: its one call signature the function's required parameters fit,
 * or of several, one whose parameters take what any of them takes.
 */
function contextualCallSignature(c: Checker, type: Type, node: TreeNode): Signature | undefined {
  if (type.kind !== 'object' && type.kind !== 'intersection' && type.kind !== 'typeParameter') return undefined;
  const requiredCount = requiredParameterCount(node);
  const signatures = c
    .signaturesOf(type, 'call')
    .filter((signature) => hasRestParameter(signature) || signature.parameters.length >= requiredCount);
  if (signatures.length < 2) return signatures[0];
  let combined: Signature | undefined = signatures[0];
  for (const signature of signatures.slice(1)) {
    const mapper = identicalTypeParametersMapper(c, combined, signature);
    if (!mapper) return undefined;
    combined = intersectedSignature(
      c,
      combined,
      mapper.size > 0 ? c.instantiateSignature(signature, mapper) : signature
    );
  }
  return combined;
}

/**
 * The signature of an intersection of two functions with the same type parameters, whose parameters take what either
 * one takes and whose `this` is what either one's is.
 */
function intersectedSignature(c: Checker, left: Signature, right: Signature): Signature {
  const [longest, shorter] = left.parameters.length >= right.parameters.length ? [left, right] : [right, left];
  const minimum = Math.max(minArgumentCount(left), minArgumentCount(right));
  const parameters = longest.parameters.map((parameter, index) => {
    const other = shorter.parameters[index] ?? shorter.parameters.find((candidate) => candidate.rest);
    const otherType = other?.rest && !parameter.rest ? c.restElementType(other.type) : other?.type;
    return {
      ...parameter,
      type: unionOf([parameter.type, otherType ?? unknownType]),
      optional: !parameter.rest && index >= minimum,
    };
  });
  return {
    typeParameters: left.typeParameters,
    parameters,
    thisType:
      left.thisType && right.thisType ? unionOf([left.thisType, right.thisType]) : (left.thisType ?? right.thisType),
    returnType: () => intersectionOf([left.returnType(), right.returnType()], c.budget),
  };
}

/** Whether two signatures take the same type parameters and parameters, as TypeScript compares a union's signatures. */
function haveIdenticalParameters(c: Checker, source: Signature, target: Signature): boolean {
  if (
    source.parameters.length !== target.parameters.length ||
    minArgumentCount(source) !== minArgumentCount(target) ||
    hasRestParameter(source) !== hasRestParameter(target)
  )
    return false;
  const mapper = identicalTypeParametersMapper(c, source, target);
  return (
    mapper !== undefined &&
    source.parameters.every((parameter, index) =>
      identicalTypes(c, parameter.type, c.instantiate(target.parameters[index].type, mapper))
    )
  );
}

/**
 * The mapper from the target's type parameters to the source's when they have the same constraints and defaults, as
 * TypeScript requires of signatures it combines.
 */
function identicalTypeParametersMapper(c: Checker, source: Signature, target: Signature): Mapper | undefined {
  if (source.typeParameters.length !== target.typeParameters.length) return undefined;
  const mapper: Mapper = new Map(
    target.typeParameters.map((parameter, index) => [parameter.id, source.typeParameters[index]])
  );
  const identicalAfterMapping = (sourceType: Type | undefined, targetType: Type | undefined): boolean =>
    identicalTypes(c, sourceType ?? unknownType, targetType ? c.instantiate(targetType, mapper) : unknownType);
  const identical = source.typeParameters.every((parameter, index) => {
    const other = target.typeParameters[index];
    return (
      identicalAfterMapping(parameter.constraint?.(), other.constraint?.()) &&
      identicalAfterMapping(parameter.default?.(), other.default?.())
    );
  });
  return identical ? mapper : undefined;
}

function identicalTypes(c: Checker, source: Type, target: Type): boolean {
  return source === target || (isAnyLike(source) === isAnyLike(target) && c.relations.identical(source, target));
}

/** How many parameters a function expression requires, which a contextual signature must have at least. */
function requiredParameterCount(node: TreeNode): number {
  const parametersNode = node.childForFieldName('parameters');
  if (!parametersNode) return node.childForFieldName('parameter') ? 1 : 0;
  let count = 0;
  for (const parameter of named(parametersNode)) {
    const pattern = parameter.childForFieldName('pattern') ?? parameter;
    if (pattern.type === 'this') continue;
    if (
      parameter.type !== 'required_parameter' ||
      parameter.childForFieldName('value') ||
      pattern.type === 'rest_pattern'
    )
      break;
    count++;
  }
  return count;
}

function hasRestParameter(signature: Signature): boolean {
  return signature.parameters.at(-1)?.rest === true;
}

function minArgumentCount(signature: Signature): number {
  const index = signature.parameters.findIndex((parameter) => parameter.optional || parameter.rest);
  return index === -1 ? signature.parameters.length : index;
}
