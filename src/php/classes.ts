// code-gauge-allow-file fileNcss 700 -- Class linking, objects, properties, and methods share PHP's visibility rules.
import type { ClassDecl, FunctionDecl, MethodDeclAst, PropertyDeclAst } from './ast';
import { lower } from './bytes';
import { type ArgValue, functionDisplayName, invoke } from './calls';
import { debugType, toBool } from './conversions';
import { deprecated, fatal, throwError, warn } from './errors';
import { share } from './places';
import { FatalError, rt } from './runtime';
import { coerce, describeType, NO_MATCH, typeToString } from './types';
import {
  type Callable,
  type ClassConst,
  type Method,
  PhpArray,
  PhpClass,
  PhpObject,
  type PropDecl,
  Ref,
  type Slot,
  UNINIT,
  type UserFunction,
  type Value,
  type Visibility,
} from './values';

/** Evaluates a constant expression of a class in that class's scope, which the interpreter provides. */
let evaluateInClass: (e: import('./ast').Expr, cls: PhpClass) => Value = () => null;

export function setClassEvaluator(run: (e: import('./ast').Expr, cls: PhpClass) => Value): void {
  evaluateInClass = run;
}

export function findClass(name: string): PhpClass | undefined {
  return rt().classes.get(lower(name.startsWith('\\') ? name.slice(1) : name));
}

export function requireClass(name: string): PhpClass {
  const cls = findClass(name);
  if (!cls) throwError('Error', `Class "${name}" not found`);
  return cls;
}

/** Whether a class declaration can be bound before the program runs, as PHP's early binding does. */
export function canDeclareEarly(decl: ClassDecl, declared: Set<string>): boolean {
  if (decl.interfaces.length > 0 || decl.traits.length > 0) return false;
  if (decl.kind === 'interface' || decl.kind === 'trait') return decl.interfaces.length === 0;
  if (!decl.parent) return true;
  const parent = lower(decl.parent);
  return declared.has(parent) || (findClass(parent)?.isUser === false);
}

// Declaration ----------------------------------------------------------------------------------------------------------

// code-gauge-allow functionCognitiveComplexity 40 -- Class linking follows PHP's inheritance checks in order.
// code-gauge-allow functionNcss 80 -- Class linking follows PHP's inheritance checks in order.
export function declareClass(decl: ClassDecl, row: number): PhpClass {
  const runtime = rt();
  const key = lower(decl.name);
  if (!decl.isAnonymous && runtime.classes.has(key)) {
    const existing = runtime.classes.get(key) as PhpClass;
    const kind = decl.kind === 'interface' ? 'interface' : decl.kind === 'trait' ? 'trait' : 'class';
    throw new FatalError(
      existing.isUser
        ? `Cannot declare ${kind} ${decl.name}, because the name is already in use`
        : `Cannot declare ${kind} ${decl.name}, because the name is already in use`,
      row
    );
  }
  const cls = new PhpClass(decl.name, decl.kind);
  cls.decl = decl;
  cls.isUser = true;
  cls.isAnonymous = decl.isAnonymous;
  cls.isAbstract = decl.isAbstract;
  cls.isFinal = decl.isFinal;
  cls.isReadonly = decl.isReadonly;
  cls.declaredRow = row;
  if (decl.parent) {
    const parent = findClass(decl.parent);
    if (!parent) throwError('Error', `Class "${decl.parent}" not found`);
    if (parent.kind === 'interface') throw new FatalError(`Class ${decl.name} cannot extend interface ${parent.name}`, row);
    if (parent.kind === 'trait') throw new FatalError(`Class ${decl.name} cannot extend trait ${parent.name}`, row);
    if (parent.isFinal) throw new FatalError(`Class ${decl.name} cannot extend final class ${parent.name}`, row);
    if (parent.isReadonly !== decl.isReadonly) {
      throw new FatalError(
        decl.isReadonly
          ? `Readonly class ${decl.name} cannot extend non-readonly class ${parent.name}`
          : `Non-readonly class ${decl.name} cannot extend readonly class ${parent.name}`,
        row
      );
    }
    cls.parent = parent;
    inherit(cls, parent);
  }
  for (const name of decl.interfaces) {
    const iface = findClass(name);
    if (!iface) {
      throwError('Error', `${decl.kind === 'interface' ? 'Interface' : 'Interface'} "${name}" not found`);
    }
    if (iface.kind !== 'interface') {
      throw new FatalError(
        decl.kind === 'interface'
          ? `${decl.name} cannot implement ${iface.name} - it is not an interface`
          : `${decl.name} cannot implement ${iface.name} - it is not an interface`,
        row
      );
    }
    cls.ownInterfaces.push(iface);
    addInterface(cls, iface);
  }
  for (const use of decl.traits) {
    for (const name of use.names) {
      const trait = findClass(name);
      if (!trait) throwError('Error', `Trait "${name}" not found`);
      if (trait.kind !== 'trait') throw new FatalError(`${decl.name} cannot use ${trait.name} - it is not a trait`, use.row);
      cls.traits.push(trait);
    }
  }
  for (const constant of decl.consts) addConst(cls, constant);
  for (const iface of cls.interfaces) {
    for (const [name, constant] of iface.consts) if (!cls.consts.has(name)) cls.consts.set(name, constant);
  }
  for (const prop of decl.props) addProperty(cls, prop, row);
  applyTraits(cls, decl);
  for (const method of decl.methods) addMethod(cls, method);
  checkInheritance(cls, row);
  if (!decl.isAnonymous) runtime.classes.set(key, cls);
  runtime.userClasses.push(cls);
  return cls;
}

function addInterface(cls: PhpClass, iface: PhpClass): void {
  if (!cls.interfaces.includes(iface)) cls.interfaces.push(iface);
  for (const parent of iface.interfaces) if (!cls.interfaces.includes(parent)) cls.interfaces.push(parent);
}

function inherit(cls: PhpClass, parent: PhpClass): void {
  for (const iface of parent.interfaces) addInterface(cls, iface);
  cls.props = [...parent.props];
  for (const [name, decl] of parent.propByName) cls.propByName.set(name, decl);
  for (const [name, constant] of parent.consts) cls.consts.set(name, constant);
  cls.createInternal = parent.createInternal;
}

function addConst(cls: PhpClass, ast: ClassDecl['consts'][number]): void {
  const inherited = cls.consts.get(ast.name);
  if (inherited?.isFinal && inherited.cls !== cls) {
    throw new FatalError(`${cls.name}::${ast.name} cannot override final constant ${inherited.cls.name}::${ast.name}`, ast.row);
  }
  const constant: ClassConst = {
    name: ast.name,
    cls,
    visibility: ast.visibility,
    isFinal: ast.isFinal,
    type: ast.type,
    evaluate: () => evaluateInClass(ast.value, cls),
  };
  cls.consts.set(ast.name, constant);
}

function propertyKey(cls: PhpClass, name: string, visibility: Visibility): string {
  return visibility === 'private' ? `\0${cls.name}\0${name}` : name;
}

// code-gauge-allow functionCognitiveComplexity 25 -- Property redeclaration follows PHP's checks in order.
function addProperty(cls: PhpClass, ast: PropertyDeclAst, row: number, fromTrait?: PhpClass): void {
  const inherited = cls.propByName.get(ast.name);
  if (inherited && inherited.cls !== cls && inherited.visibility !== 'private') {
    if (inherited.isStatic !== ast.isStatic) {
      throw new FatalError(
        ast.isStatic
          ? `Cannot redeclare non static ${inherited.cls.name}::$${ast.name} as static ${cls.name}::$${ast.name}`
          : `Cannot redeclare static ${inherited.cls.name}::$${ast.name} as non static ${cls.name}::$${ast.name}`,
        ast.row
      );
    }
    if (visibilityRank(ast.visibility) < visibilityRank(inherited.visibility)) {
      throw new FatalError(
        `Access level to ${cls.name}::$${ast.name} must be ${inherited.visibility === 'public' ? 'public' : 'protected'} (as in class ${inherited.cls.name})${inherited.visibility === 'protected' ? ' or weaker' : ''}`,
        ast.row
      );
    }
    if (inherited.type && (!ast.type || typeToString(inherited.type) !== typeToString(ast.type))) {
      throw new FatalError(`Type of ${cls.name}::$${ast.name} must be ${typeToString(inherited.type)} (as in class ${inherited.cls.name})`, ast.row);
    }
    if (!inherited.type && ast.type) {
      throw new FatalError(`Type of ${cls.name}::$${ast.name} must not be defined (as in class ${inherited.cls.name})`, ast.row);
    }
  }
  const decl: PropDecl = {
    name: ast.name,
    key: propertyKey(cls, ast.name, ast.visibility),
    cls,
    visibility: ast.visibility,
    setVisibility: ast.setVisibility ?? (ast.isReadonly && ast.visibility === 'public' ? 'protected' : undefined),
    isStatic: ast.isStatic,
    isReadonly: ast.isReadonly,
    type: ast.type,
    hasDefault: ast.defaultExpr !== undefined,
    isVirtual: ast.isVirtual,
  };
  if (ast.defaultExpr) {
    const expression = ast.defaultExpr;
    let cached: { value: Value } | undefined;
    decl.defaultValue = () => {
      cached ??= { value: checkPropertyDefault(decl, evaluateInClass(expression, cls)) };
      return share(cached.value);
    };
  }
  if (ast.hooks) {
    decl.hooks = {
      get: ast.hooks.get ? hookFunction(ast.hooks.get) : undefined,
      set: ast.hooks.set ? hookFunction(ast.hooks.set) : undefined,
      setParam: ast.hooks.setParam,
    };
  }
  void fromTrait;
  void row;
  if (ast.isStatic) {
    const ref: LazyRef = new Ref(null);
    // Static properties take their initial values when the class is first used, as constant expressions may refer to
    // classes declared later.
    ref.lazy = () => (decl.defaultValue ? decl.defaultValue() : decl.type ? (UNINIT as unknown as Value) : null);
    cls.staticProps.set(ast.name, { ref, decl });
    cls.propByName.set(ast.name, decl);
    return;
  }
  const index = cls.props.findIndex((existing) => existing.name === ast.name && existing.visibility !== 'private');
  if (index !== -1 && decl.visibility !== 'private') cls.props[index] = decl;
  else if (index !== -1 && decl.visibility === 'private') cls.props[index] = decl;
  else cls.props.push(decl);
  cls.propByName.set(ast.name, decl);
  if (decl.visibility === 'private') cls.privateProps.set(ast.name, decl);
}

function checkPropertyDefault(decl: PropDecl, value: Value): Value {
  if (!decl.type) return value;
  const coerced = coerce(value, decl.type, { strict: true, internal: false, scope: decl.cls });
  if (coerced === NO_MATCH) {
    throw new FatalError(
      `Cannot use ${debugType(value)} as default value for property ${decl.cls.name}::$${decl.name} of type ${typeToString(decl.type)}`,
      decl.cls.declaredRow
    );
  }
  return coerced;
}

function hookFunction(decl: FunctionDecl): UserFunction {
  return { kind: 'user', name: decl.name, decl, params: decl.params, statics: new Map() };
}

function visibilityRank(visibility: Visibility): number {
  return visibility === 'public' ? 2 : visibility === 'protected' ? 1 : 0;
}

function addMethod(cls: PhpClass, ast: MethodDeclAst, scope = cls): void {
  const fn: UserFunction = { kind: 'user', name: ast.fn.name, decl: ast.fn, params: ast.fn.params, statics: new Map() };
  const method: Method = {
    name: ast.fn.name,
    lname: lower(ast.fn.name),
    cls,
    fn,
    isStatic: ast.isStatic,
    isAbstract: ast.isAbstract,
    isFinal: ast.isFinal,
    visibility: ast.visibility,
    scope,
  };
  cls.methods.set(method.lname, method);
}

// code-gauge-allow functionCognitiveComplexity 30 -- Trait composition follows PHP's conflict rules.
function applyTraits(cls: PhpClass, decl: ClassDecl): void {
  if (cls.traits.length === 0) return;
  const rules = decl.traits.flatMap((use) => use.rules);
  const excluded = new Set<string>();
  for (const rule of rules) {
    if (rule.k !== 'insteadof') continue;
    for (const other of rule.instead) excluded.add(`${lower(other)}::${lower(rule.method)}`);
  }
  const ownMethods = new Set(decl.methods.map((method) => lower(method.fn.name)));
  const added = new Map<string, PhpClass>();
  for (const trait of cls.traits) {
    for (const [lname, method] of allTraitMethods(trait)) {
      if (excluded.has(`${lower(trait.name)}::${lname}`)) continue;
      if (ownMethods.has(lname)) continue;
      const previous = added.get(lname);
      if (previous && previous !== trait) {
        throw new FatalError(
          `Trait method ${trait.name}::${method.name} has not been applied as ${cls.name}::${method.name}, because of collision with ${previous.name}::${method.name}`,
          decl.row
        );
      }
      added.set(lname, trait);
      cls.methods.set(lname, { ...method, cls, scope: cls, fn: copyFunction(method.fn) });
    }
    for (const prop of trait.decl?.props ?? []) {
      const existing = cls.propByName.get(prop.name);
      if (existing && existing.cls === cls) continue;
      addProperty(cls, prop, decl.row, trait);
    }
    for (const [name, constant] of trait.consts) {
      if (!cls.consts.has(name)) cls.consts.set(name, { ...constant, cls, evaluate: constant.evaluate });
    }
  }
  for (const rule of rules) {
    if (rule.k !== 'as') continue;
    const traits = rule.trait ? [findClass(rule.trait) as PhpClass] : cls.traits;
    const source = traits.find((trait) => trait && allTraitMethods(trait).has(lower(rule.method)));
    if (!source) {
      throw new FatalError(`An alias was defined for ${rule.trait ? `${rule.trait}::` : ''}${rule.method} but this method does not exist`, decl.row);
    }
    const method = allTraitMethods(source).get(lower(rule.method)) as Method;
    if (rule.alias) {
      if (!ownMethods.has(lower(rule.alias))) {
        cls.methods.set(lower(rule.alias), {
          ...method,
          name: rule.alias,
          lname: lower(rule.alias),
          cls,
          scope: cls,
          visibility: rule.visibility ?? method.visibility,
          fn: copyFunction(method.fn),
        });
      }
    } else if (rule.visibility) {
      const own = cls.methods.get(lower(rule.method));
      if (own) cls.methods.set(own.lname, { ...own, visibility: rule.visibility });
    }
  }
}

function allTraitMethods(trait: PhpClass): Map<string, Method> {
  return trait.methods;
}

function copyFunction(fn: Callable): Callable {
  if (fn.kind === 'native') return fn;
  return { ...fn, statics: new Map() };
}

// code-gauge-allow functionCognitiveComplexity 35 -- Inheritance checks follow PHP's order of messages.
function checkInheritance(cls: PhpClass, row: number): void {
  for (const method of cls.methods.values()) {
    const parentMethod = cls.parent?.findMethod(method.lname);
    if (parentMethod && parentMethod.visibility !== 'private') checkOverride(cls, method, parentMethod);
    for (const iface of cls.interfaces) {
      const ifaceMethod = iface.methods.get(method.lname);
      if (ifaceMethod && ifaceMethod !== method) checkOverride(cls, method, ifaceMethod);
    }
  }
  if (cls.kind !== 'class' || cls.isAbstract) return;
  const missing: Method[] = [];
  const seen = new Set<string>();
  for (let current: PhpClass | undefined = cls; current; current = current.parent) {
    for (const method of current.methods.values()) {
      if (seen.has(method.lname)) continue;
      seen.add(method.lname);
      if (method.isAbstract) missing.push(method);
    }
  }
  for (const iface of cls.interfaces) {
    for (const method of iface.methods.values()) {
      if (seen.has(method.lname)) continue;
      seen.add(method.lname);
      missing.push(method);
    }
  }
  if (missing.length > 0) {
    const names = missing.slice(0, 3).map((method) => `${method.cls.name}::${method.name}`);
    const count = missing.length;
    throw new FatalError(
      `${cls.isAnonymous ? 'Class' : 'Class'} ${cls.isAnonymous ? 'class@anonymous' : cls.name} contains ${count} abstract method${count === 1 ? '' : 's'} and must therefore be declared abstract or implement the remaining method${count === 1 ? '' : 's'} (${names.join(', ')}${count > 3 ? ', ...' : ''})`,
      row
    );
  }
}

function checkOverride(cls: PhpClass, method: Method, parent: Method): void {
  if (parent.isFinal && method.cls === cls && !parent.cls.decl?.isAnonymous) {
    throw new FatalError(`Cannot override final method ${parent.cls.name}::${parent.name}()`, method.fn.kind === 'user' ? method.fn.decl.row : 0);
  }
  const row = method.fn.kind === 'user' ? method.fn.decl.row : 0;
  if (parent.isStatic !== method.isStatic) {
    throw new FatalError(
      parent.isStatic
        ? `Cannot make static method ${parent.cls.name}::${parent.name}() non static in class ${cls.name}`
        : `Cannot make non static method ${parent.cls.name}::${parent.name}() static in class ${cls.name}`,
      row
    );
  }
  if (visibilityRank(method.visibility) < visibilityRank(parent.visibility)) {
    throw new FatalError(
      `Access level to ${cls.name}::${method.name}() must be ${parent.visibility}${parent.visibility === 'protected' ? ' (as in class ' + parent.cls.name + ') or weaker' : ` (as in class ${parent.cls.name})`}`,
      row
    );
  }
  if (lower(method.name) === '__construct' && !parent.isAbstract && parent.cls.kind !== 'interface') return;
  if (!signatureCompatible(method.fn, parent.fn)) {
    throw new FatalError(
      `Declaration of ${signatureText(method)} must be compatible with ${signatureText(parent)}`,
      row
    );
  }
}

function signatureCompatible(child: Callable, parent: Callable): boolean {
  const childParams = child.params;
  const parentParams = parent.params;
  const childRequired = childParams.filter((param) => !param.optional && !param.variadic).length;
  if (childRequired > parentParams.filter((param) => !param.variadic).length) return false;
  for (const [index, param] of parentParams.entries()) {
    const own = childParams[index] ?? (childParams.at(-1)?.variadic ? childParams.at(-1) : undefined);
    if (!own) return false;
    if (param.byRef !== own.byRef) return false;
    if (own.type && !param.type) {
      if (!(own.type.k === 'named' && own.type.name === 'mixed')) return false;
    }
  }
  const parentReturn = parent.kind === 'user' ? parent.decl.returnType : parent.returnType;
  const childReturn = child.kind === 'user' ? child.decl.returnType : child.returnType;
  if (parentReturn && !childReturn && parent.kind === 'user') {
    return false;
  }
  return true;
}

function signatureText(method: Method): string {
  const fn = method.fn;
  const params = fn.params
    .map((param) => {
      let text = '';
      if (param.type) text += `${typeToString(param.type)} `;
      if (param.byRef) text += '&';
      if (param.variadic) text += '...';
      text += `$${param.name}`;
      if (param.optional && !param.variadic) {
        const defaultExpr = fn.kind === 'user' ? fn.decl.params.find((other) => other.name === param.name)?.defaultExpr : undefined;
        text += ` = ${defaultExpr ? defaultText(defaultExpr) : '<default>'}`;
      }
      return text;
    })
    .join(', ');
  const returnType = fn.kind === 'user' ? fn.decl.returnType : fn.returnType;
  return `${method.scope.name}::${method.name}(${params})${returnType ? `: ${typeToString(returnType)}` : ''}`;
}

function defaultText(e: import('./ast').Expr): string {
  if (e.k === 'lit') {
    if (e.v === null) return 'null';
    if (typeof e.v === 'string') return `'${e.v}'`;
    if (typeof e.v === 'boolean') return e.v ? 'true' : 'false';
    return String(e.v);
  }
  if (e.k === 'array') return '[]';
  return '<expression>';
}

// Objects ------------------------------------------------------------------------------------------------------------

/** Creates an object of a class with its properties' initial values, without calling the constructor. */
export function createObject(cls: PhpClass): PhpObject {
  const runtime = rt();
  const object = runtime.newObject(cls);
  for (const decl of cls.props) {
    if (decl.isVirtual && decl.hooks) continue;
    let value: Slot;
    if (decl.defaultValue) value = decl.defaultValue();
    else value = decl.type ? UNINIT : null;
    object.props.set(decl.key, value);
  }
  if (cls.createInternal) object.internal = cls.createInternal(object);
  return object;
}

export function checkInstantiable(cls: PhpClass): void {
  if (cls.kind === 'interface') throwError('Error', `Cannot instantiate interface ${cls.name}`);
  if (cls.kind === 'trait') throwError('Error', `Cannot instantiate trait ${cls.name}`);
  if (cls.kind === 'enum') throwError('Error', `Cannot instantiate enum ${cls.name}`);
  if (cls.isAbstract) throwError('Error', `Cannot instantiate abstract class ${cls.name}`);
}

/** Creates an object and runs its constructor, as `new` does. */
export function instantiate(cls: PhpClass, args: ArgValue[], callRow: number, scope: PhpClass | undefined): PhpObject {
  checkInstantiable(cls);
  const object = createObject(cls);
  rt().frame.temporaries.push(object);
  const constructor = cls.findMethod('__construct');
  if (constructor) {
    if (!canCall(constructor, scope)) {
      throwError(
        'Error',
        `Call to ${constructor.visibility} ${constructor.scope.name}::__construct() from ${scope ? `scope ${scope.name}` : 'global scope'}`
      );
    }
    invoke({ fn: constructor.fn, thisObj: object, scope: constructor.scope, staticClass: cls, method: constructor }, args, callRow);
  }
  return object;
}

/** Whether code in `scope` may call a method. */
export function canCall(method: Method, scope: PhpClass | undefined): boolean {
  if (method.visibility === 'public') return true;
  if (!scope) return false;
  if (method.visibility === 'private') return scope === method.scope;
  return scope.isSubclassOf(rootDeclarer(method)) || rootDeclarer(method).isSubclassOf(scope);
}

/** The class that first declared a protected method, which decides which classes share access to it. */
function rootDeclarer(method: Method): PhpClass {
  let root = method.scope;
  for (let cls = method.scope.parent; cls; cls = cls.parent) {
    const parent = cls.methods.get(method.lname);
    if (parent && parent.visibility !== 'private') root = parent.scope;
  }
  return root;
}

/** Finds the method code in `scope` calls on an object of `cls`, honoring private methods of the scope. */
export function lookupMethod(cls: PhpClass, lname: string, scope: PhpClass | undefined): Method | undefined {
  if (scope) {
    const own = scope.methods.get(lname);
    if (own && own.visibility === 'private' && own.scope === scope && cls.isSubclassOf(scope)) return own;
  }
  return cls.findMethod(lname);
}

// Properties ---------------------------------------------------------------------------------------------------------

/** The declaration code in `scope` sees for a property of an object, honoring private properties of the scope. */
export function lookupProp(cls: PhpClass, name: string, scope: PhpClass | undefined): PropDecl | undefined {
  if (scope) {
    const own = scope.privateProps.get(name);
    if (own && cls.isSubclassOf(scope)) return own;
  }
  return cls.propByName.get(name);
}

export function canAccessProp(decl: PropDecl, scope: PhpClass | undefined): boolean {
  if (decl.visibility === 'public') return true;
  if (!scope) return false;
  if (decl.visibility === 'private') return scope === decl.cls;
  return scope.isSubclassOf(rootPropDeclarer(decl)) || rootPropDeclarer(decl).isSubclassOf(scope);
}

function canWriteProp(decl: PropDecl, scope: PhpClass | undefined): boolean {
  const visibility = decl.setVisibility ?? decl.visibility;
  if (visibility === 'public') return true;
  if (!scope) return false;
  if (visibility === 'private') return scope === decl.cls;
  return scope.isSubclassOf(rootPropDeclarer(decl)) || rootPropDeclarer(decl).isSubclassOf(scope);
}

function rootPropDeclarer(decl: PropDecl): PhpClass {
  let root = decl.cls;
  for (let cls = decl.cls.parent; cls; cls = cls.parent) {
    const parent = cls.propByName.get(decl.name);
    if (parent && parent.visibility !== 'private' && !parent.isStatic) root = parent.cls;
  }
  return root;
}

function scopeText(scope: PhpClass | undefined): string {
  return scope ? `scope ${scope.name}` : 'global scope';
}

/** Calls a magic method, guarding against recursion into the same property. */
function callMagic(object: PhpObject, method: Method, args: Value[]): Value {
  return invoke(
    { fn: method.fn, thisObj: object, scope: method.scope, staticClass: object.cls, method },
    args.map((v) => ({ v })),
    rt().row
  );
}

function guarded(object: PhpObject, key: string, run: () => Value): Value {
  object.guards ??= new Set();
  object.guards.add(key);
  try {
    return run();
  } finally {
    object.guards.delete(key);
  }
}

// code-gauge-allow functionCognitiveComplexity 30 -- Property reads follow PHP's lookup with hooks, magic, and visibility.
export function readProp(object: PhpObject, name: string, scope: PhpClass | undefined, quiet = false): Value {
  rt().spend();
  const decl = lookupProp(object.cls, name, scope);
  if (decl && !decl.isStatic) {
    if (!canAccessProp(decl, scope)) {
      const magic = object.cls.findMethod('__get');
      if (magic && !object.guards?.has(`get:${name}`)) return guarded(object, `get:${name}`, () => callMagic(object, magic, [name]));
      throwError('Error', `Cannot access ${decl.visibility} property ${object.cls.name}::$${name}`);
    }
    if (decl.hooks?.get && !object.guards?.has(`hook:${name}`)) {
      return guarded(object, `hook:${name}`, () =>
        invoke({ fn: decl.hooks?.get as Callable, thisObj: object, scope: decl.cls, staticClass: object.cls }, [], rt().row)
      );
    }
    if (decl.isVirtual && decl.hooks && !decl.hooks.get) {
      throwError('Error', `Property ${object.cls.name}::$${name} is write-only`);
    }
    const slot = object.props.get(decl.key);
    if (slot === undefined || slot === UNINIT) {
      const magic = object.cls.findMethod('__get');
      if (magic && slot === undefined && !object.guards?.has(`get:${name}`)) {
        return guarded(object, `get:${name}`, () => callMagic(object, magic, [name]));
      }
      if (decl.type && slot !== undefined) {
        throwError('Error', `Typed property ${decl.cls.name}::$${name} must not be accessed before initialization`);
      }
      if (decl.type) {
        throwError('Error', `Typed property ${decl.cls.name}::$${name} must not be accessed before initialization`);
      }
      if (!quiet) warn(`Undefined property: ${object.cls.name}::$${name}`);
      return null;
    }
    return slot instanceof Ref ? slot.v : slot;
  }
  const slot = object.props.get(name);
  if (slot !== undefined && slot !== UNINIT) return slot instanceof Ref ? slot.v : slot;
  const magic = object.cls.findMethod('__get');
  if (magic && !object.guards?.has(`get:${name}`)) return guarded(object, `get:${name}`, () => callMagic(object, magic, [name]));
  if (!quiet) warn(`Undefined property: ${object.cls.name}::$${name}`);
  return null;
}

// code-gauge-allow functionCognitiveComplexity 40 -- Property writes follow PHP's checks for hooks, magic, readonly, and types.
export function writeProp(object: PhpObject, name: string, value: Value, scope: PhpClass | undefined): void {
  rt().spend();
  const decl = lookupProp(object.cls, name, scope);
  if (decl && !decl.isStatic) {
    if (!canAccessProp(decl, scope)) {
      const magic = object.cls.findMethod('__set');
      if (magic && !object.guards?.has(`set:${name}`)) {
        guarded(object, `set:${name}`, () => callMagic(object, magic, [name, value]));
        return;
      }
      if (decl.isReadonly) throwError('Error', `Cannot modify protected readonly property ${object.cls.name}::$${name}`);
      throwError('Error', `Cannot access ${decl.visibility} property ${object.cls.name}::$${name}`);
    }
    if (decl.hooks?.set && !object.guards?.has(`hook:${name}`)) {
      guarded(object, `hook:${name}`, () =>
        invoke({ fn: decl.hooks?.set as Callable, thisObj: object, scope: decl.cls, staticClass: object.cls }, [{ v: value }], rt().row)
      );
      return;
    }
    if (decl.isVirtual && decl.hooks && !decl.hooks.set) {
      throwError('Error', `Property ${object.cls.name}::$${name} is read-only`);
    }
    if (decl.isReadonly) {
      const current = object.props.get(decl.key);
      const initialized = current !== UNINIT && current !== undefined;
      if (initialized && !object.cloning) throwError('Error', `Cannot modify readonly property ${object.cls.name}::$${name}`);
      if (!canWriteProp(decl, scope) || (scope !== decl.cls && !object.cloning)) {
        if (scope === undefined || !scope.isSubclassOf(decl.cls)) {
          throwError('Error', `Cannot initialize readonly property ${object.cls.name}::$${name} from ${scope ? `scope ${scope.name}` : 'global scope'}`);
        }
      }
      if (object.cloning) {
        object.readonlyInit ??= new Set();
        if (object.readonlyInit.has(decl.key)) throwError('Error', `Cannot modify readonly property ${object.cls.name}::$${name}`);
        object.readonlyInit.add(decl.key);
      }
    } else if (!canWriteProp(decl, scope)) {
      const visibility = decl.setVisibility ?? decl.visibility;
      throwError('Error', `Cannot modify ${visibility}(set) property ${object.cls.name}::$${name} from ${scopeText(scope)}`);
    }
    const coerced = decl.type ? coerceProperty(decl, value, object) : value;
    const slot = object.props.get(decl.key);
    if (slot instanceof Ref) slot.v = coerced;
    else object.props.set(decl.key, share(coerced));
    return;
  }
  const slot = object.props.get(name);
  if (slot !== undefined) {
    if (slot instanceof Ref) slot.v = value;
    else object.props.set(name, share(value));
    return;
  }
  const magic = object.cls.findMethod('__set');
  if (magic && !object.guards?.has(`set:${name}`)) {
    guarded(object, `set:${name}`, () => callMagic(object, magic, [name, value]));
    return;
  }
  createDynamicProp(object, name);
  object.props.set(name, share(value));
}

export function createDynamicProp(object: PhpObject, name: string): void {
  if (object.cls.isReadonly) throwError('Error', `Cannot create dynamic property ${object.cls.name}::$${name}`);
  if (object.cls.name !== 'stdClass' && !allowsDynamicProps(object.cls)) {
    deprecated(`Creation of dynamic property ${object.cls.isAnonymous ? 'class@anonymous' : object.cls.name}::$${name} is deprecated`);
  }
}

function allowsDynamicProps(cls: PhpClass): boolean {
  for (let current: PhpClass | undefined = cls; current; current = current.parent) {
    if (current.name === 'stdClass' || current.name === 'ArrayObject' || current.name === 'Closure') return true;
  }
  return false;
}

export function coerceProperty(decl: PropDecl, value: Value, object?: PhpObject): Value {
  const type = decl.type;
  if (!type) return value;
  const coerced = coerce(value, type, { strict: rt().strictTypes, internal: false, scope: decl.cls, staticClass: object?.cls });
  if (coerced === NO_MATCH) {
    throwError(
      'TypeError',
      `Cannot assign ${debugType(value)} to property ${(object?.cls ?? decl.cls).name}::$${decl.name} of type ${describeType(type, decl.cls)}`
    );
  }
  return coerced;
}

/** The reference a property holds, creating it, for `=&`, by-reference arguments, and nested writes. */
export function propRef(object: PhpObject, name: string, scope: PhpClass | undefined): Ref {
  const decl = lookupProp(object.cls, name, scope);
  const key = decl && !decl.isStatic ? decl.key : name;
  if (decl && !decl.isStatic && !canAccessProp(decl, scope)) {
    throwError('Error', `Cannot access ${decl.visibility} property ${object.cls.name}::$${name}`);
  }
  if (decl?.isReadonly) {
    const slot = object.props.get(key);
    if (slot !== UNINIT && slot !== undefined) throwError('Error', `Cannot modify readonly property ${object.cls.name}::$${name}`);
  }
  let slot = object.props.get(key);
  if (slot instanceof Ref) return slot;
  if (slot === undefined && !decl) {
    const magic = object.cls.findMethod('__get');
    if (magic && !object.guards?.has(`get:${name}`)) {
      const value = guarded(object, `get:${name}`, () => callMagic(object, magic, [name]));
      if (!(value instanceof PhpObject)) {
        warn(`Indirect modification of overloaded property ${object.cls.name}::$${name} has no effect`);
      }
      return new Ref(value);
    }
    createDynamicProp(object, name);
  }
  if (slot === UNINIT || slot === undefined) slot = null;
  const ref = new Ref(slot);
  ref.isRef = true;
  object.props.set(key, ref);
  return ref;
}

export function unsetProp(object: PhpObject, name: string, scope: PhpClass | undefined): void {
  const decl = lookupProp(object.cls, name, scope);
  if (decl && !decl.isStatic) {
    if (!canAccessProp(decl, scope)) {
      const magic = object.cls.findMethod('__unset');
      if (magic) {
        callMagic(object, magic, [name]);
        return;
      }
      throwError('Error', `Cannot access ${decl.visibility} property ${object.cls.name}::$${name}`);
    }
    if (decl.isReadonly) throwError('Error', `Cannot unset readonly property ${object.cls.name}::$${name}`);
    const slot = object.props.get(decl.key);
    if (slot instanceof Ref) slot.rc--;
    if (decl.type) object.props.set(decl.key, UNINIT);
    else object.props.delete(decl.key);
    return;
  }
  if (object.props.has(name)) {
    const slot = object.props.get(name);
    if (slot instanceof Ref) slot.rc--;
    object.props.delete(name);
    return;
  }
  const magic = object.cls.findMethod('__unset');
  if (magic) callMagic(object, magic, [name]);
}

export function issetProp(object: PhpObject, name: string, scope: PhpClass | undefined): boolean {
  const decl = lookupProp(object.cls, name, scope);
  if (decl && !decl.isStatic && canAccessProp(decl, scope)) {
    if (decl.hooks?.get) return readProp(object, name, scope, true) !== null;
    const slot = object.props.get(decl.key);
    if (slot !== undefined && slot !== UNINIT) return (slot instanceof Ref ? slot.v : slot) !== null;
  } else if (!decl || decl.isStatic) {
    const slot = object.props.get(name);
    if (slot !== undefined && slot !== UNINIT) return (slot instanceof Ref ? slot.v : slot) !== null;
  }
  const magic = object.cls.findMethod('__isset');
  if (magic && !object.guards?.has(`isset:${name}`)) {
    return toBool(guarded(object, `isset:${name}`, () => callMagic(object, magic, [name])));
  }
  return false;
}

/** The properties of an object that code in `scope` can see, by name, in table order. */
export function visibleProps(object: PhpObject, scope: PhpClass | undefined): [string, Value][] {
  const entries: [string, Value][] = [];
  for (const [key, slot] of object.props) {
    if (slot === UNINIT) continue;
    const name = propNameOf(key);
    const decl = declForKey(object.cls, key);
    if (decl && !canAccessProp(decl, scope)) continue;
    if (decl && decl.visibility === 'private' && scope !== decl.cls) continue;
    entries.push([name, slot instanceof Ref ? slot.v : slot]);
  }
  return entries;
}

export function propNameOf(key: string): string {
  if (key.startsWith('\0')) return key.slice(key.indexOf('\0', 1) + 1);
  return key;
}

export function declForKey(cls: PhpClass, key: string): PropDecl | undefined {
  if (key.startsWith('\0')) {
    const className = key.slice(1, key.indexOf('\0', 1));
    const owner = findClassInChain(cls, className);
    return owner?.privateProps.get(propNameOf(key));
  }
  const decl = cls.propByName.get(key);
  return decl && !decl.isStatic && decl.key === key ? decl : undefined;
}

function findClassInChain(cls: PhpClass, name: string): PhpClass | undefined {
  for (let current: PhpClass | undefined = cls; current; current = current.parent) if (current.name === name) return current;
  return undefined;
}

// Static members -----------------------------------------------------------------------------------------------------

/** A static property's reference, whose initial value is computed when the program first reads it. */
export type LazyRef = Ref & { lazy?: () => Value };

export function resolveStatic(ref: LazyRef): Ref {
  if (ref.lazy) {
    const lazy = ref.lazy;
    ref.lazy = undefined;
    ref.v = lazy();
  }
  return ref;
}

export function staticPropRef(cls: PhpClass, name: string, scope: PhpClass | undefined): Ref {
  const found = cls.findStatic(name);
  if (!found) throwError('Error', `Access to undeclared static property ${cls.name}::$${name}`);
  if (!canAccessProp(found.decl, scope)) {
    throwError('Error', `Cannot access ${found.decl.visibility} property ${cls.name}::$${name}`);
  }
  return resolveStatic(found.ref);
}

export function readStaticProp(cls: PhpClass, name: string, scope: PhpClass | undefined): Value {
  const ref = staticPropRef(cls, name, scope);
  const value = ref.v;
  if ((value as unknown) === UNINIT) {
    throwError('Error', `Typed static property ${cls.name}::$${name} must not be accessed before initialization`);
  }
  return value;
}

export function classConstant(cls: PhpClass, name: string, scope: PhpClass | undefined): Value {
  const constant = cls.findConst(name);
  if (!constant) throwError('Error', `Undefined constant ${cls.name}::${name}`);
  if (constant.visibility !== 'public') {
    const allowed =
      scope !== undefined &&
      (constant.visibility === 'private' ? scope === constant.cls : scope.isSubclassOf(constant.cls) || constant.cls.isSubclassOf(scope));
    if (!allowed) throwError('Error', `Cannot access ${constant.visibility} constant ${cls.name}::${name}`);
  }
  if (constant.value === undefined) {
    if (constant.evaluating) throwError('Error', `Cannot declare self-referencing constant ${constant.cls.name}::${name}`);
    constant.evaluating = true;
    try {
      let value = (constant.evaluate as () => Value)();
      if (constant.type) {
        const coerced = coerce(value, constant.type, { strict: true, internal: false, scope: constant.cls });
        if (coerced === NO_MATCH) {
          throwError('TypeError', `Cannot use ${debugType(value)} as value for class constant ${constant.cls.name}::${name} of type ${typeToString(constant.type)}`);
        }
        value = coerced;
      }
      constant.value = value;
    } finally {
      constant.evaluating = false;
    }
  }
  return share(constant.value as Value);
}

export function methodDisplay(method: Method): string {
  return functionDisplayName({ fn: method.fn, method });
}

export { fatal };

export function objectToArray(object: PhpObject): PhpArray {
  const array = new PhpArray();
  for (const [key, slot] of object.props) {
    if (slot === UNINIT) continue;
    const decl = declForKey(object.cls, key);
    let arrayKey = key;
    if (decl?.visibility === 'protected') arrayKey = `\0*\0${decl.name}`;
    array.set(arrayKey, slot instanceof Ref ? slot.v : slot);
  }
  return array;
}
