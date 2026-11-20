import { defineLegacyFunctionProperties } from './argumentsObject';
import { listFromArrayLike } from './arrayOps';
import { defineFunctionProperties } from './memberProperties';
import type { RealmBuilder } from './realm';
import { toInteger } from './realmArrays';
import { WELL_KNOWN_SYMBOLS } from './realmIterators';
import type { Runtime } from './runtime';
import { isCallable, JsFunction, type NativeCall, type Value } from './values';

export function defineFunction(builder: RealmBuilder): void {
  const { functionPrototype } = builder.realm;
  defineFunctionProperties(functionPrototype as JsFunction, '', 0);
  builder.defineClass('Function', 1, functionPrototype, ({ runtime }) =>
    runtime.throwError('TypeError', 'Function() is not supported')
  );
  builder.method(functionPrototype, 'call', 1, ({ runtime, thisValue, args, callRow }) =>
    runtime.call(thisValue, args[0], args.slice(1), callRow)
  ).forwardsLegacyCaller = true;
  builder.method(functionPrototype, 'apply', 2, ({ runtime, thisValue, args, callRow }) => {
    // The receiver is checked before the argument list, whose getters may have effects.
    if (!isCallable(thisValue)) throwNotApplicable(runtime, thisValue);
    return runtime.call(thisValue, args[0], listFromArrayLike(runtime, args[1]), callRow);
  }).forwardsLegacyCaller = true;
  builder.method(functionPrototype, 'bind', 1, bindFunction);
  builder.constant(
    functionPrototype,
    WELL_KNOWN_SYMBOLS.hasInstance,
    builder.function('[Symbol.hasInstance]', 1, ({ runtime, thisValue, args }) =>
      runtime.ordinaryHasInstance(thisValue, args[0])
    )
  );
  builder.method(functionPrototype, 'toString', 0, ({ runtime, thisValue }) => {
    if (!(thisValue instanceof JsFunction))
      return runtime.throwError('TypeError', 'Function.prototype.toString requires a function');
    return runtime.functionSource(thisValue);
  });
  defineLegacyFunctionProperties(builder);
}

function bindFunction({ runtime, thisValue, args }: NativeCall): JsFunction {
  const target = thisValue;
  if (!isCallable(target)) return runtime.throwError('TypeError', 'Bind must be called on a function');
  const prototype = target.proto;
  const boundThis = args[0];
  const boundArgs = args.slice(1);
  runtime.allocate(boundArgs.length + 1);
  const targetLength = runtime.getOwnProperty(target, 'length') ? runtime.get(target, 'length') : undefined;
  const length =
    typeof targetLength === 'number' ? Math.max(0, toInteger(runtime, targetLength) - boundArgs.length) : 0;
  const targetName = runtime.get(target, 'name');
  const bound = runtime.newNativeFunction(
    `bound ${typeof targetName === 'string' ? targetName : ''}`,
    length,
    (call) =>
      call.newTarget
        ? runtime.construct(
            target,
            [...boundArgs, ...call.args],
            call.newTarget === bound ? target : call.newTarget,
            call.callRow
          )
        : runtime.call(target, boundThis, [...boundArgs, ...call.args], call.callRow),
    target.isConstructor
  );
  bound.forwardsLegacyCaller = true;
  bound.setPrototype(prototype);
  bound.boundTarget = target;
  bound.captured = [target, boundThis, ...boundArgs];
  return bound;
}

function throwNotApplicable(runtime: Runtime, receiver: Value): never {
  const kind =
    receiver === undefined || receiver === null
      ? String(receiver)
      : typeof receiver === 'object'
        ? 'an object'
        : `a ${typeof receiver}`;
  return runtime.throwError(
    'TypeError',
    () =>
      `Function.prototype.apply was called on ${runtime.describePlain(receiver)}, which is ${kind} and not a function`
  );
}
