import { enc, lower } from './bytes';
import { parseSignature, parseTypeText } from './calls';
import { rt } from './runtime';
import {
  type ClassKind,
  type Method,
  type NativeContext,
  type NativeFunction,
  type NativeObjectComparison,
  PhpArray,
  PhpClass,
  PhpObject,
  type PropDecl,
  type Value,
  type Visibility,
} from './values';

const functions: NativeFunction[] = [];
const constants: [string, Value | (() => Value)][] = [];
const compileConstants = new Map<string, Value>();
const constantDeprecations = new Map<string, string>();
const classDefinitions: ClassDefinition[] = [];

/** Defines a builtin function from its signature as PHP's stubs write it. */
export function defineFunction(
  signature: string,
  impl: (ctx: NativeContext) => Value,
  needsCaller = false,
  nullTypes?: Record<number, string>
): void {
  const { name, params, returnType } = parseSignature(signature);
  if (nullTypes) for (const [index, param] of params.entries()) param.nativeNullType = nullTypes[index];
  functions.push({ kind: 'native', name, params, returnType, impl, needsCaller });
}

export function defineOverloadedFunction(
  shortSignature: string,
  signature: string,
  impl: (ctx: NativeContext) => Value,
  options: { nullTypes?: Record<number, string>; shortParamsDirectOnly?: boolean } = {}
): void {
  const { name, params, returnType } = parseSignature(signature);
  if (options.nullTypes) for (const [index, param] of params.entries()) param.nativeNullType = options.nullTypes[index];
  const shortParams = parseSignature(shortSignature).params;
  functions.push({
    kind: 'native',
    name,
    params,
    shortParams,
    shortParamsDirectOnly: options.shortParamsDirectOnly,
    returnType,
    impl,
  });
}

/** Marks a native function whose direct calls PHP compiles away, as {@link NativeFunction.inlined} says. */
export function markInlined(name: string): void {
  markedFunction(name).inlined = true;
}

export function markDirectOnly(...names: string[]): void {
  for (const name of names) markedFunction(name).directOnly = true;
}

function markedFunction(name: string): NativeFunction {
  const fn = functions.find((candidate) => candidate.name === name);
  if (!fn) throw new Error(`Unknown function ${name}`);
  return fn;
}

export function defineAlias(alias: string, target: string): void {
  const fn = functions.find((candidate) => candidate.name === target);
  if (!fn) throw new Error(`Unknown alias target ${target}`);
  functions.push({ ...fn, name: alias });
}

export function nativeParameters(name: string): NativeFunction['params'] | undefined {
  return functions.find((fn) => lower(fn.name) === lower(name))?.params;
}

export function nativeMethodParameters(className: string, methodName: string): NativeFunction['params'] | undefined {
  const seen = new Set<string>();
  let name: string | undefined = className;
  while (name && !seen.has(lower(name))) {
    seen.add(lower(name));
    const definition = nativeClassDefinition(name);
    if (!definition) return;
    const method = definition.methods?.find(
      (method) => lower(method.signature.slice(0, method.signature.indexOf('('))) === lower(methodName)
    );
    if (method) return parseSignature(method.signature).params;
    name = definition.parent;
  }
}

/** Defines a builtin constant; reading one with a `deprecation` should report that message as E_DEPRECATED. */
export function defineConstant(name: string, value: Value, deprecation?: string): void {
  constants.push([name, value]);
  if (deprecation) constantDeprecations.set(name, deprecation);
  else compileConstants.set(name, value);
}

export function compileConstant(name: string): Value | undefined {
  return compileConstants.get(name);
}

export function defineRuntimeConstant(name: string, create: () => Value): void {
  constants.push([name, create]);
}

/** The E_DEPRECATED message PHP reports when a script reads the builtin constant `name`, if PHP deprecates it. */
export function constantDeprecation(name: string): string | undefined {
  return constantDeprecations.get(name);
}

export interface NativeMethod {
  signature: string;
  acceptsNamed?: boolean;
  impl: (ctx: NativeContext & { thisObj: PhpObject }) => Value;
  isStatic?: boolean;
  isFinal?: boolean;
  isAbstract?: boolean;
  visibility?: Visibility;
}

export interface ClassDefinition {
  name: string;
  kind?: ClassKind;
  parent?: string;
  interfaces?: string[];
  isAbstract?: boolean;
  isFinal?: boolean;
  isCloneable?: boolean;
  props?: { name: string; visibility: Visibility; defaultValue?: () => Value; type?: string; isReadonly?: boolean }[];
  consts?: Record<string, Value>;
  methods?: NativeMethod[];
  createInternal?: (object: PhpObject) => unknown;
  compare?: NativeObjectComparison;
}

export function nativeClassDefinition(name: string): ClassDefinition | undefined {
  const key = lower(name);
  return classDefinitions.find((definition) => lower(definition.name) === key);
}

export function defineClass(definition: ClassDefinition): void {
  classDefinitions.push(definition);
}

/** Installs the builtin functions, constants, and classes into a run. */
export function installNatives(): void {
  const runtime = rt();
  for (const fn of functions) runtime.functions.set(lower(fn.name), fn);
  for (const [name, definition] of constants) {
    const value = typeof definition === 'function' ? definition() : definition;
    runtime.constants.set(name, value);
    if (value instanceof PhpArray || value instanceof PhpObject) runtime.rootConstants.add(value);
    if (value instanceof PhpArray) value.persistentHolder = true;
  }
  for (const definition of classDefinitions) runtime.classes.set(lower(definition.name), buildClass(definition));
}

// code-gauge-allow functionCognitiveComplexity 25 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
// code-gauge-allow functionNcss 45 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
function buildClass(definition: ClassDefinition): PhpClass {
  const runtime = rt();
  const cls = new PhpClass(definition.name, definition.kind ?? 'class');
  cls.isAbstract = definition.isAbstract ?? false;
  cls.isFinal = definition.isFinal ?? false;
  if (definition.parent) {
    const parent = runtime.classes.get(lower(definition.parent));
    if (!parent) throw new Error(`Unknown builtin parent ${definition.parent}`);
    cls.parent = parent;
    cls.props = [...parent.props];
    for (const [name, decl] of parent.propByName) cls.propByName.set(name, decl);
    for (const [name, constant] of parent.consts) cls.consts.set(name, constant);
    cls.createInternal = parent.createInternal;
  }
  cls.isCloneable = definition.isCloneable ?? cls.parent?.isCloneable ?? true;
  // A builtin class lists every interface it implements in PHP's order; a subclass without any inherits them reversed.
  for (const name of definition.interfaces ?? []) {
    const iface = runtime.classes.get(lower(name));
    if (!iface) throw new Error(`Unknown builtin interface ${name}`);
    cls.ownInterfaces.push(iface);
  }
  cls.interfaces = cls.ownInterfaces.length > 0 ? [...cls.ownInterfaces] : (cls.parent?.interfaces.toReversed() ?? []);
  if (definition.createInternal) cls.createInternal = definition.createInternal;
  cls.compare = definition.compare ?? cls.parent?.compare;
  for (const prop of definition.props ?? []) {
    const decl: PropDecl = {
      name: prop.name,
      key: prop.visibility === 'private' ? `\0${cls.name}\0${prop.name}` : prop.name,
      cls,
      visibility: prop.visibility,
      isStatic: false,
      isReadonly: prop.isReadonly ?? false,
      isFinal: false,
      hasDefault: prop.defaultValue !== undefined || prop.type === undefined,
      defaultValue: prop.defaultValue,
      type: prop.type ? parseTypeText(prop.type) : undefined,
    };
    const index = cls.props.findIndex((existing) => existing.name === prop.name);
    if (index === -1) cls.props.push(decl);
    else cls.props[index] = decl;
    cls.propByName.set(prop.name, decl);
    if (prop.visibility === 'private') cls.privateProps.set(prop.name, decl);
  }
  for (const [name, value] of Object.entries(definition.consts ?? {})) {
    cls.consts.set(name, { name, cls, visibility: 'public', isFinal: false, value });
  }
  for (const nativeMethod of definition.methods ?? []) {
    const { name: rawName, params, returnType } = parseSignature(nativeMethod.signature);
    const name = enc(rawName);
    const fn: NativeFunction = {
      kind: 'native',
      name,
      params,
      returnType,
      acceptsNamed: nativeMethod.acceptsNamed,
      impl: nativeMethod.impl as (ctx: NativeContext) => Value,
    };
    const method: Method = {
      name,
      lname: lower(name),
      cls,
      fn,
      isStatic: nativeMethod.isStatic ?? false,
      isAbstract: nativeMethod.isAbstract ?? definition.kind === 'interface',
      isFinal: nativeMethod.isFinal ?? false,
      visibility: nativeMethod.visibility ?? 'public',
      scope: cls,
    };
    cls.methods.set(method.lname, method);
  }
  return cls;
}
