import { convertRepr, type Core, type Eval, type Repr, reprOf } from './compilerBase';
import type { Frame } from './runtime';
import type { ClassSymbol, FunctionSymbol, PropertySymbol } from './symbols';
import { Boxed, KObject, NULL, UNIT, type Value } from './values';

let core: Core | undefined;

export function setDispatchCore(classes: Core): void {
  core = classes;
}

function coreClasses(): Core {
  if (!core) throw new Error('The core classes are not loaded');
  return core;
}

/** The class of a value at run time, which virtual calls dispatch on. */
export function runtimeClassOf(value: Value): ClassSymbol {
  const classes = coreClasses();
  if (value instanceof KObject) return value.cls;
  if (value instanceof Boxed) return classes.primitiveClasses[value.kind];
  if (typeof value === 'string') return classes.string;
  if (typeof value === 'boolean') return classes.boolean;
  if (value === UNIT) return classes.unit;
  return classes.any;
}

/** Whether calls of a member must look up the implementation in the receiver's class. */
export function isVirtual(member: FunctionSymbol | PropertySymbol): boolean {
  const { owner } = member;
  if (!owner) return false;
  // A final class's members have no overrides, and calling them directly works for an unboxed `Double` receiver,
  // whose class a raw number does not tell.
  if (!owner.isInheritable && owner.kind !== 'enum') return false;
  return member.isAbstract || member.isOpen || (member.isOverride && owner.isInheritable) || owner.isInterface;
}

/** How the arguments of a function are held, which a call converts them to. */
export function parameterReprs(symbol: FunctionSymbol): Repr[] {
  const classes = coreClasses();
  return symbol.params.map((param) => (param.isVararg ? 'ref' : reprOf(classes, param.type)));
}

export function receiverRepr(symbol: FunctionSymbol | PropertySymbol): Repr {
  const classes = coreClasses();
  if (symbol.extensionReceiver) return reprOf(classes, symbol.extensionReceiver);
  if (symbol.owner && classes.primitives.has(symbol.owner)) return reprOf(classes, symbol.owner.type);
  return 'ref';
}

export function returnRepr(symbol: FunctionSymbol): Repr {
  return reprOf(coreClasses(), symbol.returnType ?? coreClasses().unit.type);
}

export function propertyRepr(symbol: PropertySymbol): Repr {
  return reprOf(coreClasses(), symbol.type ?? coreClasses().any.type);
}

/** Converts one value between representations, outside a compiled expression. */
function convertValue(value: Value, fromRepr: Repr, toRepr: Repr): Value {
  return fromRepr === toRepr ? value : convertRepr(() => value, fromRepr, toRepr)(undefined as unknown as Frame);
}

type Bridge = (frame: Frame, receiver: Value, args: Value[], callRow: number | undefined) => Value;

/**
 * The bridges by the overriding function, which belongs to one run, and then by the overridden one. Keyed the other
 * way, a library function such as `Any.toString` would keep every run's overrides alive for the life of the process.
 */
const bridges = new WeakMap<FunctionSymbol, Map<FunctionSymbol, Bridge>>();

/**
 * Calls an overriding function as the overridden one is called, converting the receiver, the arguments, and the
 * result between their representations where the two declare them differently, as the JVM's bridge methods do.
 */
function bridge(symbol: FunctionSymbol, target: FunctionSymbol): Bridge {
  let bySymbol = bridges.get(target);
  if (!bySymbol) {
    bySymbol = new Map();
    bridges.set(target, bySymbol);
  }
  const existing = bySymbol.get(symbol);
  if (existing) return existing;
  const from = parameterReprs(symbol);
  const to = parameterReprs(target);
  const fromReceiver = receiverRepr(symbol);
  const toReceiver = receiverRepr(target);
  const fromResult = returnRepr(target);
  const toResult = returnRepr(symbol);
  const same =
    fromReceiver === toReceiver && fromResult === toResult && from.every((repr, index) => repr === to[index]);
  const created: Bridge = same
    ? (frame, receiver, args, callRow) => invokeFunction(target, frame, receiver, args, callRow)
    : (frame, receiver, args, callRow) => {
        const convertedArgs = args.map((arg, index) => convertValue(arg, from[index] ?? 'ref', to[index] ?? 'ref'));
        const result = invokeFunction(
          target,
          frame,
          convertValue(receiver, fromReceiver, toReceiver),
          convertedArgs,
          callRow
        );
        return convertValue(result, fromResult, toResult);
      };
  bySymbol.set(symbol, created);
  return created;
}

function invokeFunction(
  symbol: FunctionSymbol,
  frame: Frame,
  receiver: Value,
  args: Value[],
  callRow: number | undefined
): Value {
  const { invoke } = symbol;
  if (!invoke) throw new Error(`The function ${symbol.owner?.name ?? ''}.${symbol.name} has no implementation`);
  return invoke(frame, receiver, args, callRow);
}

/** Calls a function, dispatching a virtual member on the receiver's class. */
export function callFunction(
  symbol: FunctionSymbol,
  frame: Frame,
  receiver: Value,
  args: Value[],
  callRow: number | undefined
): Value {
  requireMemberReceiver(symbol, frame, receiver);
  if (!isVirtual(symbol)) return invokeFunction(symbol, frame, receiver, args, callRow);
  const target = runtimeClassOf(receiver).dispatch(symbol);
  if (target === symbol) return invokeFunction(symbol, frame, receiver, args, callRow);
  return bridge(symbol, target)(frame, receiver, args, callRow);
}

export function getPropertyValue(symbol: PropertySymbol, frame: Frame, receiver: Value): Value {
  requireMemberReceiver(symbol, frame, receiver);
  const target = isVirtual(symbol) ? runtimeClassOf(receiver).dispatch(symbol) : symbol;
  const { get } = target;
  if (!get) throw new Error(`The property ${symbol.name} has no getter`);
  const value = get(frame, receiver);
  if (target === symbol) return value;
  return convertRepr(() => value, propertyRepr(target), propertyRepr(symbol))(frame);
}

export function setPropertyValue(symbol: PropertySymbol, frame: Frame, receiver: Value, value: Value): void {
  requireMemberReceiver(symbol, frame, receiver);
  const target = isVirtual(symbol) ? runtimeClassOf(receiver).dispatch(symbol) : symbol;
  const { set } = target;
  if (!set) throw new Error(`The property ${symbol.name} has no setter`);
  set(
    frame,
    receiver,
    target === symbol ? value : convertRepr(() => value, propertyRepr(symbol), propertyRepr(target))(frame)
  );
}

export type { Eval };

/**
 * A receiver of a non-null type is null only when a superclass's initializer reads a property that the subclass has yet
 * to initialize, where the JVM throws a NullPointerException.
 */
function requireMemberReceiver(symbol: FunctionSymbol | PropertySymbol, frame: Frame, receiver: Value): void {
  const isStatic = symbol.kind === 'function' && symbol.isConstructor;
  if (receiver === NULL && symbol.owner && !symbol.extensionReceiver && !isStatic && !symbol.owner.isObject) {
    frame.runtime.throwError(frame, 'java.lang.NullPointerException');
  }
}
