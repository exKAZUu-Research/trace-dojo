import type { Position } from './ast';
import type { BoundArgument, BoundExpression, BoundLValue } from './bound';
import type { ArgumentInfo } from './callBinder';
import type { BindContext } from './convertBinder';
import type { ExpressionBinder } from './expressionBinder';
import {
  type ArrayType,
  displayType,
  displayTypeSymbol,
  ERROR_TYPE,
  isSpecial,
  LocalSymbol,
  type MethodSymbol,
  type NamedType,
  type ParameterSymbol,
  substitute,
  type Type,
} from './types';

/** The parts of an interpolated string, its literal texts and its holes bound to their natural types. */
export type InterpolationParts = Extract<BoundExpression, { kind: 'interpolated' }>['parts'];

/**
 * An interpolated string bound as a `string`, which a conversion to another type (C# spec §10.2.5) binds again from its
 * parts: where it and each hole are, and where it is bound.
 */
export interface InterpolationSource {
  parts: InterpolationParts;
  position: Position;
  holes: Position[];
  context: BindContext;
}

/** The kind of interpolated string conversion to a type: to FormattableString or IFormattable, or to a handler. */
export function interpolationTargetOf(target: Type): 'formattable' | 'handler' | undefined {
  if (target.kind !== 'named') return undefined;
  const name = target.symbol.fullName;
  if (target.symbol.isLibrary && (name === 'System.FormattableString' || name === 'System.IFormattable'))
    return 'formattable';
  return target.symbol.isInterpolatedStringHandler ? 'handler' : undefined;
}

/**
 * Converts an interpolated string to FormattableString or IFormattable as Roslyn lowers it: a call of
 * `FormattableStringFactory.Create` with the composite format of the parts and the holes as an object array.
 */
export function bindFormattable(
  binder: ExpressionBinder,
  source: InterpolationSource,
  target: Type,
  row: number
): BoundExpression {
  const factory = binder.library.typeNamed('System.Runtime.CompilerServices.FormattableStringFactory');
  const create = factory.methods.find((method) => method.name === 'Create') as MethodSymbol;
  let format = '';
  const elements: BoundExpression[] = [];
  for (const part of source.parts) {
    if (typeof part === 'string') {
      format += part.replaceAll('{', '{{').replaceAll('}', '}}');
      continue;
    }
    const alignment = part.alignment === undefined ? '' : `,${part.alignment}`;
    format += `{${elements.length}${alignment}${part.format === undefined ? '' : `:${part.format}`}}`;
    elements.push(binder.convert(part.value, binder.objectType, row));
  }
  const arrayType: ArrayType = { kind: 'array', element: binder.objectType, rank: 1 };
  const call: BoundExpression = {
    kind: 'call',
    method: create,
    receiver: undefined,
    args: [
      binder.constant(format, binder.stringType, row),
      {
        kind: 'newArray',
        arrayType,
        sizes: [binder.constant(elements.length, binder.intType, row)],
        elements,
        type: arrayType,
        row,
      },
    ],
    typeArgs: [],
    owner: factory.declaredType,
    isVirtual: false,
    type: create.returnType,
    row,
  };
  return binder.convert(call, target, row);
}

/**
 * Converts an interpolated string to a handler type (C# 10) as Roslyn lowers it, which decides the order that the
 * program runs and the trace shows: the handler is created by `new H(literalLength, formattedCount, ...arguments)`, or
 * with a trailing `out bool` when no constructor takes the arguments without it; then, part by part in source order,
 * `AppendLiteral(text)` for a literal and `AppendFormatted(value[, alignment][, format])` for a hole, whose value is
 * evaluated just before its call. A false `out bool` skips every append, and an append that returns false the ones
 * after it.
 */
export function bindHandler(
  binder: ExpressionBinder,
  source: InterpolationSource,
  target: NamedType,
  handlerArguments: BoundExpression[],
  row: number
): BoundExpression {
  const { context, position } = source;
  const handler = hiddenLocal('\0handler', target, position, context);
  const handlerValue: BoundExpression = { kind: 'local', local: handler, type: target, row };
  const failed: BoundExpression = { kind: 'default', type: ERROR_TYPE, row };
  const created = createHandler(binder, source, target, handlerArguments, row);
  if (!created) return failed;
  const appends = bindAppends(binder, source, handlerValue);
  if (!appends) return failed;
  const sideEffects: BoundExpression[] = [
    { kind: 'assign', target: handlerValue as BoundLValue, value: created.creation, type: target, row },
  ];
  const enabled: BoundExpression | undefined = created.enabled && {
    kind: 'local',
    local: created.enabled,
    type: binder.boolType,
    row,
  };
  sideEffects.push(...guardedAppends(binder, enabled, appends, row));
  const locals = created.enabled ? [handler, created.enabled] : [handler];
  return { kind: 'sequence', locals, sideEffects, value: handlerValue, type: target, row };
}

/** The appends as the handler runs them: `enabled && a1 && a2 ...` for bool ones, under `if (enabled)` for void ones. */
function guardedAppends(
  binder: ExpressionBinder,
  enabled: BoundExpression | undefined,
  appends: { calls: BoundExpression[]; returnsBool: boolean },
  row: number
): BoundExpression[] {
  const boolType = binder.boolType;
  if (appends.returnsBool) {
    let chain: BoundExpression | undefined;
    for (const right of [...(enabled ? [enabled] : []), ...appends.calls])
      chain = chain ? { kind: 'logical', operator: '&&', left: chain, right, type: boolType, row } : right;
    return chain ? [chain] : [];
  }
  if (!enabled) return appends.calls;
  const done = binder.constant(true, boolType, row);
  return [
    {
      kind: 'conditional',
      condition: enabled,
      whenTrue: { kind: 'sequence', locals: [], sideEffects: appends.calls, value: done, type: boolType, row },
      whenFalse: binder.constant(false, boolType, row),
      type: boolType,
      row,
    },
  ];
}

/** A local that holds a value of the lowering, which no program names. */
export function hiddenLocal(name: string, type: Type, position: Position, context: BindContext): LocalSymbol {
  const local = new LocalSymbol(name, type, position.row, position.column);
  local.isHidden = true;
  context.fn.addLocal(local);
  return local;
}

/**
 * The handler's creation, with the local that its trailing `out bool` sets, if it takes one; or undefined after
 * reporting both constructors that Roslyn tries, as CS1729 for each argument count.
 */
function createHandler(
  binder: ExpressionBinder,
  source: InterpolationSource,
  target: NamedType,
  handlerArguments: BoundExpression[],
  row: number
): { creation: BoundExpression; enabled: LocalSymbol | undefined } | undefined {
  const literals = source.parts.filter((part) => typeof part === 'string');
  const literalLength = literals.join('').length;
  const formattedCount = source.parts.length - literals.length;
  const leading = [literalLength, formattedCount].map((value) => binder.constant(value, binder.intType, row));
  const args = [...leading, ...handlerArguments].map((expression) => argument(expression, row));
  const saved = binder.diagnostics.length;
  const creation = construct(binder, target, args, row);
  if (creation) return { creation, enabled: undefined };
  const firstErrors = binder.diagnostics.splice(saved);
  const enabled = hiddenLocal('\0handlerEnabled', binder.boolType, source.position, source.context);
  const enabledValue: BoundExpression = { kind: 'local', local: enabled, type: binder.boolType, row };
  const withEnabled = construct(
    binder,
    target,
    [...args, { ...argument(enabledValue, row), refKind: 'out', target: enabledValue as BoundLValue }],
    row
  );
  if (withEnabled) {
    binder.diagnostics.splice(saved);
    return { creation: withEnabled, enabled };
  }
  binder.diagnostics.splice(saved, 0, ...firstErrors);
  return undefined;
}

function argument(expression: BoundExpression, row: number): ArgumentInfo {
  return { expression, name: undefined, refKind: undefined, row, target: undefined };
}

function construct(
  binder: ExpressionBinder,
  target: NamedType,
  args: ArgumentInfo[],
  row: number
): BoundExpression | undefined {
  const candidates = target.symbol.constructors.map((method) => ({ method, owner: target }));
  const resolved = binder.resolveCall(candidates, args, undefined, row, {
    name: target.symbol.name,
    kind: 'constructor',
    typeName: displayType(target),
  });
  if (!resolved) return undefined;
  return {
    kind: 'new',
    constructor: resolved.candidate.method,
    objectType: target,
    args: resolved.args,
    initializer: undefined,
    type: target,
    row,
  };
}

/**
 * The append calls of the parts, which must all return void or all bool; or undefined after reporting an append that
 * does not bind (CS8941 after the binding's own error), returns another type (CS8941), or returns otherwise than the
 * first (CS8942).
 */
function bindAppends(
  binder: ExpressionBinder,
  source: InterpolationSource,
  handler: BoundExpression
): { calls: BoundExpression[]; returnsBool: boolean } | undefined {
  const calls: BoundExpression[] = [];
  let returnType: Type | undefined;
  let holeIndex = 0;
  for (const part of source.parts) {
    const isLiteral = typeof part === 'string';
    const position = isLiteral ? source.position : source.holes[holeIndex++];
    if (part === '') continue;
    const call = bindAppend(
      binder,
      handler,
      isLiteral ? 'AppendLiteral' : 'AppendFormatted',
      appendArguments(binder, part, position.row),
      position,
      source.context
    );
    if (!call) return undefined;
    returnType ??= call.type;
    if (returnType.kind !== call.type.kind) {
      binder.error(
        position,
        'CS8942',
        `補間された文字列ハンドラー メソッド '${displayCall(call)}' の戻り値の型が一致しません。'${displayType(returnType)}' を返す必要があります。`
      );
      return undefined;
    }
    calls.push(call);
  }
  return { calls, returnsBool: returnType !== undefined && isSpecial(returnType, 'bool') };
}

/** The arguments of a part's append: a literal's text, or a hole's value with its alignment and format by name. */
function appendArguments(binder: ExpressionBinder, part: InterpolationParts[number], row: number): ArgumentInfo[] {
  if (typeof part === 'string') return [argument(binder.constant(part, binder.stringType, row), row)];
  const args = [argument(part.value, row)];
  if (part.alignment !== undefined)
    args.push({ ...argument(binder.constant(part.alignment, binder.intType, row), row), name: 'alignment' });
  if (part.format !== undefined)
    args.push({ ...argument(binder.constant(part.format, binder.stringType, row), row), name: 'format' });
  return args;
}

/** One append call, which must bind and return void or bool, or undefined after reporting why not. */
function bindAppend(
  binder: ExpressionBinder,
  handler: BoundExpression,
  name: string,
  args: ArgumentInfo[],
  position: Position,
  context: BindContext
): Extract<BoundExpression, { kind: 'call' }> | undefined {
  const saved = binder.diagnostics.length;
  const group = binder.bindInstanceMember(handler, name, undefined, position, context, true);
  const call = group.kind === 'methodGroup' ? binder.invokeMethodGroup(group, args, position, context) : undefined;
  const isValid = call?.kind === 'call' && binder.diagnostics.length === saved;
  if (isValid && (call.type.kind === 'void' || isSpecial(call.type, 'bool'))) return call;
  // Roslyn names a method that it did not find as `?.()`.
  if (isValid || group.kind !== 'methodGroup')
    binder.error(
      position,
      'CS8941',
      `補間された文字列ハンドラー メソッド '${isValid ? displayCall(call) : '?.()'}' の形式が正しくありません。'void' または 'bool' を返すことはありません。`
    );
  return undefined;
}

/** A call's method as Roslyn names it with its type arguments, as `H.AppendFormatted<int>(int)`. */
function displayCall(call: Extract<BoundExpression, { kind: 'call' }>): string {
  const { method, typeArgs } = call;
  const substitution = new Map(method.typeParameters.map((parameter, index) => [parameter, typeArgs[index]]));
  const typeArgText = typeArgs.length > 0 ? `<${typeArgs.map((type) => displayType(type)).join(', ')}>` : '';
  const parameters = method.parameters.map((parameter) => displayType(substitute(parameter.type, substitution)));
  return `${displayTypeSymbol(method.owner)}.${method.name}${typeArgText}(${parameters.join(', ')})`;
}

/** An argument for a handler parameter whose constructor takes other arguments of the call, converted last. */
export interface PendingHandlerArgument {
  parameter: ParameterSymbol;
  parameterIndex: number;
  source: InterpolationSource;
  type: NamedType;
}

/**
 * Converts the interpolated string arguments of handler parameters with `[InterpolatedStringHandlerArgument]`, whose
 * constructors take the values of the arguments that the attribute names, kept in locals as Roslyn does, and returns
 * the local that the receiver goes to when an attribute names it by `""`.
 */
export function convertHandlerArguments(
  pending: PendingHandlerArgument[],
  method: MethodSymbol,
  receiverType: NamedType,
  args: (BoundArgument | undefined)[],
  convert: (source: InterpolationSource, target: NamedType, handlerArguments: BoundExpression[]) => BoundExpression
): LocalSymbol | undefined {
  let receiver: LocalSymbol | undefined;
  for (const { parameter, parameterIndex, source, type } of pending) {
    const { position, context } = source;
    const values = (parameter.handlerArguments ?? []).map((name): BoundExpression => {
      if (name === '') {
        receiver ??= hiddenLocal('\0handlerReceiver', receiverType, position, context);
        return { kind: 'local', local: receiver, type: receiverType, row: position.row };
      }
      const index = method.parameters.findIndex((other) => other.name === name);
      const value = args[index];
      if (!value || value.kind === 'refArgument') return { kind: 'default', type: ERROR_TYPE, row: position.row };
      const temporary = hiddenLocal('\0handlerArgument', value.type, position, context);
      const local: BoundExpression = { kind: 'local', local: temporary, type: value.type, row: value.row };
      // The local outlives the sequence that stores it, until the handler's constructor reads it.
      args[index] = {
        kind: 'sequence',
        locals: [],
        sideEffects: [{ kind: 'assign', target: local as BoundLValue, value, type: value.type, row: value.row }],
        value: local,
        type: value.type,
        row: value.row,
      };
      return local;
    });
    args[parameterIndex] = convert(source, type, values);
  }
  return receiver;
}
