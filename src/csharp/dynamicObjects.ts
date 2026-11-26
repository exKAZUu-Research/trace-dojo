import type { Expression, Position } from './ast';
import type { BoundExpression } from './bound';
import type { ArgumentInfo } from './callBinder';
import type { BindContext } from './convertBinder';
import { isNonValue, type MemberBinder, type NonValue } from './memberBinder';
import type { MethodSymbol, NamedType, PropertySymbol, Type } from './types';

/**
 * A member that the runtime binder binds on an ExpandoObject or a DynamicObject lacking it: the object's internal
 * indexer, which reads, assigns, or adds the member by name; a call of an ExpandoObject's member invokes its value.
 */
export function dynamicObjectMember(
  binder: MemberBinder,
  receiver: BoundExpression,
  name: string,
  position: Position,
  isCallee: boolean
): BoundExpression | undefined {
  const owner = dynamicObjectOwner(receiver.type);
  if (!owner || (isCallee && owner.symbol.name !== 'ExpandoObject')) return undefined;
  const property = owner.symbol.properties.find(
    (candidate) => candidate.isIndexer && candidate.access === 'internal'
  ) as PropertySymbol;
  return {
    kind: 'property',
    receiver,
    property,
    args: [
      binder.constant(name, binder.stringType, position.row),
      binder.constant(true, binder.boolType, position.row),
    ],
    owner,
    type: property.type,
    row: position.row,
  };
}

/** `d.M(args)` of a DynamicObject whose type lacks `M`, which its TryInvokeMember binds as the call runs. */
export function dynamicObjectCall(
  binder: MemberBinder,
  node: Extract<Expression, { kind: 'invocation' }>,
  context: BindContext
): BoundExpression | undefined {
  if (node.target.kind !== 'memberAccess' || node.target.target.kind !== 'name') return undefined;
  const receiver = binder.bindExpression(node.target.target, context);
  if (isNonValue(receiver)) return undefined;
  const owner = dynamicObjectOwner(receiver.type);
  if (owner?.symbol.name !== 'DynamicObject') return undefined;
  const { name } = node.target;
  if (binder.lookupMember(receiver.type, name, context.fn.typeContext, 0, true).found) return undefined;
  const method = owner.symbol.methods.find(
    (candidate) => candidate.name === 'InvokeMember' && candidate.access === 'internal'
  ) as MethodSymbol;
  const nameArg: ArgumentInfo = {
    expression: binder.constant(name, binder.stringType, node.row),
    name: undefined,
    refKind: undefined,
    row: node.row,
    target: undefined,
  };
  const group: Extract<NonValue, { kind: 'methodGroup' }> = {
    kind: 'methodGroup',
    name: method.name,
    candidates: [{ method, owner }],
    receiver,
    isSimpleName: false,
    typeArgs: undefined,
    extensions: [],
    isBaseAccess: false,
    row: node.row,
  };
  return binder.invokeMethodGroup(group, [nameArg, ...binder.bindArguments(node.args, context)], node, context);
}

/**
 * The library class that binds the members a type lacks at run time, which `dynamic` finds them through: the type
 * itself for an ExpandoObject, or DynamicObject for a class that derives from it.
 */
function dynamicObjectOwner(type: Type): NamedType | undefined {
  for (let current = type.kind === 'named' ? type : undefined; current; current = current.symbol.baseType) {
    const { fullName } = current.symbol;
    if (fullName === 'System.Dynamic.ExpandoObject' || fullName === 'System.Dynamic.DynamicObject') return current;
  }
  return undefined;
}
