import type { Expression } from './ast';
import type { BoundExpression } from './bound';
import type { BindContext } from './convertBinder';
import type { MemberBinder } from './memberBinder';
import { displayType, ERROR_TYPE, isSpecial, type MethodSymbol, namedType, type Type } from './types';

/**
 * Binds `await operand` (C# spec §12.9.8) of a value that is not `dynamic` through the awaitable pattern: the
 * operand's `GetAwaiter()`, an instance or extension method; the awaiter's `IsCompleted`, a readable `bool` property;
 * its conversion to INotifyCompletion; and its `GetResult()`, whose type is the expression's. The parts are checked in
 * Roslyn's order, and only the first that fails is reported, with Roslyn's error for it.
 */
export function bindAwaitPattern(
  binder: MemberBinder,
  node: Extract<Expression, { kind: 'await' }>,
  operand: BoundExpression,
  context: BindContext
): BoundExpression {
  const { row } = node;
  const failed: BoundExpression = { kind: 'default', type: ERROR_TYPE, row };
  const getAwaiter = bindGetAwaiter(binder, node, operand.type, context);
  if (!getAwaiter) return failed;
  const awaiterType = getAwaiter.type;
  const awaiter: BoundExpression = { kind: 'compoundOperand', type: awaiterType, row };
  const badPattern = (): BoundExpression => {
    binder.error(
      node,
      'CS4011',
      `'await' では、'${displayType(operand.type)}.GetAwaiter()' の戻り値の型 '${displayType(awaiterType)}' に適切な IsCompleted、OnCompleted、GetResult メンバーがあり、INotifyCompletion または ICriticalNotifyCompletion を実装する必要があります。`
    );
    return failed;
  };
  const isCompleted = bindIsCompleted(binder, node, awaiter, context);
  if (!isCompleted) return failed;
  if (!isSpecial(isCompleted.type, 'bool')) return badPattern();
  const notifyCompletion = binder.library.typeNamed('System.Runtime.CompilerServices.INotifyCompletion');
  if (!binder.implicitConversionOf(awaiter, namedType(notifyCompletion))) {
    binder.error(node, 'CS4027', `'${displayType(awaiterType)}' は 'INotifyCompletion' を実装しません`);
    return failed;
  }
  const getResult = bindCall(binder, node, awaiter, 'GetResult', context);
  if (getResult === undefined) return failed;
  if (getResult === 'missing' || getResult.method.isExtension)
    return noSuchMember(binder, node, awaiterType, 'GetResult');
  if (hasOptionalOrParams(getResult.method)) return badPattern();
  return { kind: 'await', operand, getAwaiter, isCompleted, getResult, type: getResult.type, row };
}

/**
 * `operand.GetAwaiter()`, which must be a call of a method taking no arguments, neither static nor returning void
 * (CS1986), or undefined when the call fails, which reports why.
 */
function bindGetAwaiter(
  binder: MemberBinder,
  node: Extract<Expression, { kind: 'await' }>,
  operandType: Type,
  context: BindContext
): Extract<BoundExpression, { kind: 'call' }> | undefined {
  const operand: BoundExpression = { kind: 'compoundOperand', type: operandType, row: node.row };
  const badAwaitArgument = (): undefined => {
    binder.error(
      node,
      'CS1986',
      `'await' では、型 ${displayType(operandType)} に適切な GetAwaiter メソッドがあることが必要です`
    );
    return undefined;
  };
  const group = binder.bindInstanceMember(operand, 'GetAwaiter', undefined, node, context, true);
  if (group.kind !== 'methodGroup') {
    // A value that is not a call, as of a delegate property, is not an awaiter.
    if (!('type' in group) || group.type.kind === 'error') return undefined;
    return badAwaitArgument();
  }
  if (group.extensions.length === 0 && group.candidates.every((candidate) => candidate.method.isStatic))
    return badAwaitArgument();
  const call = invoke(binder, group, node);
  if (!call) return undefined;
  if (call.kind !== 'call' || call.type.kind === 'void' || hasOptionalOrParams(call.method)) return badAwaitArgument();
  return call;
}

/**
 * The awaiter's `IsCompleted`, which must be a property (CS0117 for anything else, or for nothing) that can be read, or
 * undefined when it is not, which reports why.
 */
function bindIsCompleted(
  binder: MemberBinder,
  node: Extract<Expression, { kind: 'await' }>,
  awaiter: BoundExpression,
  context: BindContext
): BoundExpression | undefined {
  const { found, inaccessible } = binder.lookupMember(awaiter.type, 'IsCompleted', context.fn.typeContext);
  if (found ? found.kind !== 'property' : !inaccessible) {
    noSuchMember(binder, node, awaiter.type, 'IsCompleted');
    return undefined;
  }
  const saved = binder.diagnostics.length;
  const value = binder.toValue(binder.bindInstanceMember(awaiter, 'IsCompleted', undefined, node, context), node);
  binder.checkReadable(value, node, context);
  return binder.diagnostics.length === saved ? value : undefined;
}

/** `awaiter.name()`, 'missing' when the awaiter has no such member, or undefined when the call fails. */
function bindCall(
  binder: MemberBinder,
  node: Extract<Expression, { kind: 'await' }>,
  awaiter: BoundExpression,
  name: string,
  context: BindContext
): Extract<BoundExpression, { kind: 'call' }> | 'missing' | undefined {
  const { found, inaccessible } = binder.lookupMember(awaiter.type, name, context.fn.typeContext);
  if (!found && !inaccessible) return 'missing';
  const group = binder.bindInstanceMember(awaiter, name, undefined, node, context, true);
  if (group.kind !== 'methodGroup') return undefined;
  const call = invoke(binder, group, node);
  return call?.kind === 'call' ? call : undefined;
}

/** A call of a method group without arguments, or undefined when it reports an error. */
function invoke(
  binder: MemberBinder,
  group: Parameters<MemberBinder['invokeMethodGroup']>[0],
  node: Extract<Expression, { kind: 'await' }>
): BoundExpression | undefined {
  const saved = binder.diagnostics.length;
  const call = binder.invokeMethodGroup(group, [], node);
  return binder.diagnostics.length === saved && call.type.kind !== 'error' ? call : undefined;
}

function noSuchMember(
  binder: MemberBinder,
  node: Extract<Expression, { kind: 'await' }>,
  type: Type,
  name: string
): BoundExpression {
  binder.error(node, 'CS0117', `'${displayType(type)}' に '${name}' の定義がありません`);
  return { kind: 'default', type: ERROR_TYPE, row: node.row };
}

/** Whether a method that the pattern calls without arguments has parameters, which it may not (C# spec §12.9.8.2). */
function hasOptionalOrParams(method: MethodSymbol): boolean {
  return method.parameters.length > (method.isExtension ? 1 : 0);
}
