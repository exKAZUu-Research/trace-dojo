import type { AttributeAst } from './ast';
import { findAttribute } from './attributeRules';
import type { ArgValue, CallTarget } from './calls';
import { evaluateInClass } from './classConstants';
import { E_USER_DEPRECATED, emitError, warn } from './errors';
import { toStr } from './operators';
import { rt, type Runtime } from './runtime';
import type { ClassConst, Param, PhpClass, UserFunction, Value } from './values';

/** The key of the private property holding a SensitiveParameterValue's value. */
export const SENSITIVE_VALUE_KEY = '\0SensitiveParameterValue\0value';

/** Reports what `#[\Deprecated]` and `#[\NoDiscard]` on a user function ask for, before the call binds arguments. */
export function reportCallAttributes(
  target: CallTarget,
  fn: UserFunction,
  args: readonly ArgValue[],
  discardResult: boolean
): void {
  const attributes = fn.decl.attributes;
  if (!attributes) return;
  const deprecation = findAttribute(attributes, 'Deprecated');
  const noDiscard = discardResult ? findAttribute(attributes, 'NoDiscard') : undefined;
  if (!deprecation && !noDiscard) return;
  const className = target.magic
    ? target.magic.method.cls.name
    : (target.method?.cls.name ?? (fn.decl.className === undefined ? undefined : target.scope?.name));
  const kind = className === undefined ? 'function' : 'method';
  const name = `${className === undefined ? '' : `${className}::`}${calledName(target, fn, args)}()`;
  const scope = target.scope;
  if (deprecation)
    emitError(
      E_USER_DEPRECATED,
      `${kind === 'function' ? 'Function' : 'Method'} ${name} is deprecated${deprecationSuffix(deprecation, scope)}`
    );
  if (noDiscard) {
    const message = attributeArgument(noDiscard, 0, 'message', scope);
    warn(
      `The return value of ${kind} ${name} should either be used or intentionally ignored by casting it as (void)${message ? `, ${message}` : ''}`
    );
  }
}

/** The name of the function a call named, which for a call `__call` or `__callStatic` handles is its first argument. */
function calledName(target: CallTarget, fn: UserFunction, args: readonly ArgValue[]): string {
  if (target.magic) return target.magic.name;
  const handler = target.method?.lname === '__call' || target.method?.lname === '__callstatic';
  const name = args[0]?.v;
  return handler && args.length === 2 && typeof name === 'string' ? name : fn.decl.name;
}

/** Reports the deprecation of a class constant or enum case that `#[\Deprecated]` marks. */
export function reportConstantDeprecation(constant: ClassConst): void {
  const deprecation = findAttribute(constant.attributes, 'Deprecated');
  if (!deprecation) return;
  const what = constant.isCase ? 'Enum case' : 'Constant';
  emitError(
    E_USER_DEPRECATED,
    `${what} ${constant.cls.name}::${constant.name} is deprecated${deprecationSuffix(deprecation, constant.cls)}`
  );
}

/** Reports the deprecation of the traits a class uses that `#[\Deprecated]` marks. */
export function reportTraitDeprecation(trait: PhpClass, cls: PhpClass): void {
  const deprecation = findAttribute(trait.decl?.attributes, 'Deprecated');
  if (deprecation)
    emitError(
      E_USER_DEPRECATED,
      `Trait ${trait.name} used by ${cls.name} is deprecated${deprecationSuffix(deprecation, trait)}`
    );
}

const constantDeprecations = new WeakMap<Runtime, Map<string, AttributeAst>>();

/** Remembers that a global constant the program defines is deprecated. */
export function deprecateConstant(key: string, attributes: AttributeAst[] | undefined): void {
  const deprecation = findAttribute(attributes, 'Deprecated');
  if (!deprecation) return;
  const runtime = rt();
  let deprecations = constantDeprecations.get(runtime);
  if (!deprecations) {
    deprecations = new Map();
    constantDeprecations.set(runtime, deprecations);
  }
  deprecations.set(key, deprecation);
}

/** Reports the deprecation of a global constant the program defined with `#[\Deprecated]`. */
export function reportGlobalConstantDeprecation(key: string, name: string): void {
  const deprecation = constantDeprecations.get(rt())?.get(key);
  if (deprecation)
    emitError(E_USER_DEPRECATED, `Constant ${name} is deprecated${deprecationSuffix(deprecation, undefined)}`);
}

function deprecationSuffix(attribute: AttributeAst, scope: PhpClass | undefined): string {
  const message = attributeArgument(attribute, 0, 'message', scope);
  const since = attributeArgument(attribute, 1, 'since', scope);
  return `${since ? ` since ${since}` : ''}${message ? `, ${message}` : ''}`;
}

function attributeArgument(
  attribute: AttributeAst,
  position: number,
  name: string,
  scope: PhpClass | undefined
): string | undefined {
  const named = attribute.args.find((arg) => arg.name === name);
  const argument = named ?? (attribute.args[position]?.name === undefined ? attribute.args[position] : undefined);
  if (!argument) return undefined;
  const value = evaluateInClass(argument.value, scope);
  return value === null ? undefined : toStr(value);
}

/**
 * The arguments a stack trace shows for a call, with each one a `#[\SensitiveParameter]` parameter received in a
 * SensitiveParameterValue object instead.
 */
export function hideSensitiveArguments(values: Value[], params: readonly Param[]): Value[] {
  const last = params.at(-1);
  return values.map((value, index) => {
    const param = params[index] ?? (last?.variadic ? last : undefined);
    return param?.sensitive ? sensitiveValue(value) : value;
  });
}

export function sensitiveValue(value: Value): Value {
  const object = rt().newObject(rt().classes.get('sensitiveparametervalue') as PhpClass);
  object.props.set(SENSITIVE_VALUE_KEY, value);
  return object;
}
