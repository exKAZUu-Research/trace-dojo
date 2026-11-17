// code-gauge-allow-file fileNcss 998 -- Holds the cases of one concern of the interpreter, which share their helpers.
// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import type { ClassDecl, Expr, FunctionDecl, MethodDeclAst, PropertyDeclAst } from './ast';
import builtinNames from './builtinNames.json';
import { addConst, applyTraitConstants, evaluateInClass, linkInterfaceConstants } from './classConstants';
export { canAccessConstant, classConstant, setClassEvaluator } from './classConstants';
import { lower } from './bytes';
import { type ArgValue, invoke } from './calls';
import { debugType, normalizeKeyString, toBool, valueName } from './conversions';
import { deprecated, notice, throwError, warn } from './errors';
import { strictEquals } from './operators';
import { share } from './places';
import { FatalError, rt, SCRIPT_PATH } from './runtime';
import tentativeReturnMethods from './tentativeReturnMethods.json';
import { coerce, describeType, NO_MATCH, typeToString } from './types';
import { UnsupportedFeatureError } from './unsupported';
import { unsupportedClasses } from './unsupportedCatalog';
import {
  type Callable,
  copyValueSlot,
  dropped,
  type Method,
  type Param,
  PhpArray,
  PhpClass,
  PhpObject,
  type PropDecl,
  Ref,
  setReferenceTypeCheck,
  type Slot,
  type TypeDecl,
  UNINIT,
  type UserFunction,
  type Value,
  type Visibility,
  visibilityRank,
} from './values';
import { isSubtype, sameDeclarationType } from './variance';

export function findClass(name: string): PhpClass | undefined {
  return rt().classes.get(lower(name.startsWith('\\') ? name.slice(1) : name));
}

export function requireClass(name: string): PhpClass {
  const unsupported = unsupportedClasses.get(lower(name.replace(/^\\/, '')));
  if (unsupported) throw new UnsupportedFeatureError(unsupported);
  const cls = findClass(name);
  if (!cls) {
    if (builtinNames.classes.some((builtin) => lower(builtin) === lower(name)))
      throw new UnsupportedFeatureError(`PHP の組み込みクラス（${name}）`);
    throwError('Error', `Class "${name}" not found`);
  }
  return cls;
}

/** Whether a class declaration can be bound before the program runs, as PHP's early binding does. */
export function canDeclareEarly(decl: ClassDecl, declared: Set<string>): boolean {
  if (decl.interfaces.length > 0 || decl.traits.length > 0) return false;
  if (decl.kind === 'interface' || decl.kind === 'trait') return decl.interfaces.length === 0;
  if (!decl.parent) return true;
  const parent = lower(decl.parent);
  return declared.has(parent) || findClass(parent)?.isUser === false;
}

// Declaration ----------------------------------------------------------------------------------------------------------

export function declareClass(decl: ClassDecl, row: number): PhpClass {
  const runtime = rt();
  const key = lower(decl.name);
  if (!decl.isAnonymous && runtime.classes.has(key)) {
    const existing = runtime.classes.get(key) as PhpClass;
    const kind = existing.kind === 'interface' ? 'interface' : existing.kind === 'trait' ? 'trait' : 'class';
    const previously = existing.decl ? ` (previously declared in ${SCRIPT_PATH}:${existing.decl.row + 1})` : '';
    throw new FatalError(`Cannot redeclare ${kind} ${existing.name}${previously}`, row);
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
    if (parent.kind === 'interface')
      throw new FatalError(`Class ${decl.name} cannot extend interface ${parent.name}`, row);
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
  const declared = [...decl.interfaces];
  // A class that declares __toString implements Stringable, as if it had named it last.
  if (
    decl.methods.some((method) => lower(method.fn.name) === '__tostring') &&
    !declared.some((name) => lower(name) === 'stringable')
  ) {
    declared.push('Stringable');
  }
  for (const name of declared) {
    const iface = findClass(name);
    if (!iface) throwError('Error', `Interface "${name}" not found`);
    if (iface.kind !== 'interface') {
      throw new FatalError(`${decl.name} cannot implement ${iface.name} - it is not an interface`, row);
    }
    cls.ownInterfaces.push(iface);
  }
  cls.interfaces = linkInterfaces(cls.parent, cls.ownInterfaces);
  for (const use of decl.traits) {
    for (const name of use.names) {
      const trait = findClass(name);
      if (!trait) throwError('Error', `Trait "${name}" not found`);
      if (trait.kind !== 'trait')
        throw new FatalError(`${decl.name} cannot use ${trait.name} - it is not a trait`, use.row);
      cls.traits.push(trait);
    }
  }
  for (const constant of decl.consts) addConst(cls, constant);
  linkInterfaceConstants(cls, row);
  for (const prop of decl.props) addProperty(cls, prop);
  for (const method of decl.methods) addMethod(cls, method);
  applyTraits(cls, decl);
  checkInheritance(cls, row);
  if (!decl.isAnonymous) runtime.classes.set(key, cls);
  runtime.userClasses.push(cls);
  return cls;
}

/**
 * Orders a class's interfaces as PHP's `class_implements` lists them: without interfaces of its own, a class inherits
 * its parent's in reverse; with them, it keeps its parent's, adds its own, then each one's parents in reverse.
 */
export function linkInterfaces(parent: PhpClass | undefined, own: PhpClass[]): PhpClass[] {
  if (own.length === 0) return parent ? parent.interfaces.toReversed() : [];
  const interfaces = [...(parent?.interfaces ?? [])];
  const add = (iface: PhpClass): void => {
    if (!interfaces.includes(iface)) interfaces.push(iface);
  };
  for (const iface of own) add(iface);
  for (const iface of own) for (const inherited of iface.interfaces.toReversed()) add(inherited);
  return interfaces;
}

function inherit(cls: PhpClass, parent: PhpClass): void {
  cls.props = [...parent.props];
  for (const [name, decl] of parent.propByName) cls.propByName.set(name, decl);
  for (const [name, constant] of parent.consts) cls.consts.set(name, constant);
  cls.createInternal = parent.createInternal;
}

function propertyKey(cls: PhpClass, name: string, visibility: Visibility): string {
  return visibility === 'private' ? `\0${cls.name}\0${name}` : name;
}

// code-gauge-allow functionNcss 56 -- Follows PHP's class linking and property access rules in their order of checks.
function addProperty(cls: PhpClass, ast: PropertyDeclAst, declarationScope = cls): void {
  const inherited = cls.propByName.get(ast.name);
  if (inherited && inherited.cls !== cls && inherited.isFinal)
    throw new FatalError(`Cannot override final property ${inherited.cls.name}::$${ast.name}`, ast.row);
  if (ast.isFinal && ast.visibility === 'private')
    throw new FatalError('Property cannot be both final and private', ast.row);
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
    if (inherited.isReadonly !== ast.isReadonly)
      throw new FatalError(
        `Cannot redeclare ${inherited.isReadonly ? 'readonly' : 'non-readonly'} property ${inherited.cls.name}::$${ast.name} as ${ast.isReadonly ? 'readonly' : 'non-readonly'} ${cls.name}::$${ast.name}`,
        ast.row
      );
    const setter = ast.setVisibility ?? (ast.isReadonly && ast.visibility === 'public' ? 'protected' : ast.visibility);
    const parentSetter = inherited.setVisibility ?? inherited.visibility;
    if (visibilityRank(setter) < visibilityRank(parentSetter)) {
      throw new FatalError(
        `Set access level of ${cls.name}::$${ast.name} must be ${parentSetter === 'public' ? 'omitted' : `${parentSetter}(set)`} (as in class ${inherited.cls.name})${parentSetter === 'protected' ? ' or weaker' : ''}`,
        ast.row
      );
    }
    if (inherited.type && !propertyTypeCompatible(inherited, ast, cls)) {
      propertyTypeError(inherited, cls, ast.name, ast.row);
    }
    if (!inherited.type && ast.type && !propertyTypeCompatible(inherited, ast, cls)) {
      throw new FatalError(
        `Type of ${cls.name}::$${ast.name} must not be defined (as in class ${inherited.cls.name})`,
        ast.row
      );
    }
  }
  const decl: PropDecl = {
    declarationScope,
    declarationAst: ast,
    name: ast.name,
    key: propertyKey(cls, ast.name, ast.visibility),
    cls,
    visibility: ast.visibility,
    setVisibility: ast.setVisibility ?? (ast.isReadonly && ast.visibility === 'public' ? 'protected' : undefined),
    isStatic: ast.isStatic,
    isReadonly: ast.isReadonly,
    isFinal: ast.isFinal || ast.setVisibility === 'private',
    type: ast.type,
    hasDefault: ast.defaultExpr !== undefined,
    isVirtual: ast.isVirtual,
  };
  if (ast.defaultExpr) {
    const expression = ast.defaultExpr;
    let cached: { value: Value } | undefined;
    decl.defaultValue = () => {
      cached ??= { value: checkPropertyDefault(decl, evaluateInClass(expression, cls)) };
      if (cached.value instanceof PhpArray) cached.value.persistentHolder = true;
      return share(cached.value);
    };
  }
  if (ast.hooks) {
    const setterType = ast.hooks.set?.params[0]?.type;
    if (ast.type && setterType && !isSubtype(ast.type, cls, setterType, cls))
      throw new FatalError(
        `Type of parameter $${ast.hooks.set?.params[0]?.name} of hook ${cls.name}::$${ast.name}::set must be compatible with property type`,
        ast.row
      );
    decl.hooks = {
      get: ast.hooks.get ? hookFunction(ast.hooks.get) : undefined,
      set: ast.hooks.set ? hookFunction(ast.hooks.set) : undefined,
      setParam: ast.hooks.setParam,
      abstractGet: ast.hooks.abstractGet,
      abstractSet: ast.hooks.abstractSet,
    };
  }
  if (ast.isStatic) {
    const ref: LazyRef = new Ref(null);
    const initialize = (): Value =>
      decl.defaultValue ? decl.defaultValue() : decl.type ? (UNINIT as unknown as Value) : null;
    if (!ast.defaultExpr || ast.defaultExpr.k === 'lit') ref.v = initialize();
    else ref.lazy = initialize;
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

function propertyTypeCompatible(parent: PropDecl, child: Pick<PropertyDeclAst, 'type'>, cls: PhpClass): boolean {
  if (Boolean(parent.type) !== Boolean(child.type)) return false;
  const parentType: TypeDecl = parent.type ?? { k: 'named', name: 'mixed' };
  const childType: TypeDecl = child.type ?? { k: 'named', name: 'mixed' };
  const acceptsChild = isSubtype(childType, cls, parentType, parent.cls);
  const acceptsParent = isSubtype(parentType, parent.cls, childType, cls);
  if (parent.isVirtual && parent.hooks) {
    if (!parent.hooks.set) return acceptsChild;
    if (!parent.hooks.get) return acceptsParent;
  }
  return acceptsChild && acceptsParent;
}

function propertyTypeError(parent: PropDecl, child: PhpClass, name: string, row: number): never {
  if (!parent.type)
    throw new FatalError(
      `Type of ${child.name}::$${name} must be omitted to match the parent definition in class ${parent.cls.name}`,
      row
    );
  const variance =
    parent.isVirtual && parent.hooks
      ? !parent.hooks.set
        ? 'subtype of '
        : !parent.hooks.get
          ? 'supertype of '
          : ''
      : '';
  throw new FatalError(
    `Type of ${child.name}::$${name} must be ${variance}${describeType(parent.type, parent.cls)} (as in class ${parent.cls.name})`,
    row
  );
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

// code-gauge-allow functionNcss 56 -- Follows PHP's class linking and property access rules in their order of checks.
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
  const contracts: Method[] = [];
  const propertyOrigins = new Map<string, string>();
  const constantOrigins = new Map<string, string>();
  for (const trait of cls.traits) {
    for (const [lname, method] of allTraitMethods(trait)) {
      if (method.isAbstract) {
        contracts.push({ ...method, cls, scope: trait });
        if (!cls.findMethod(lname)) cls.methods.set(lname, { ...method, cls, scope: cls, fn: copyFunction(method.fn) });
        continue;
      }
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
    applyTraitProperties(cls, trait, propertyOrigins, decl.row);
    applyTraitConstants(cls, trait, constantOrigins, decl.row);
  }
  for (const rule of rules) {
    if (rule.k !== 'as') continue;
    const traits = rule.trait ? [findClass(rule.trait) as PhpClass] : cls.traits;
    const source = traits.find((trait) => trait && allTraitMethods(trait).has(lower(rule.method)));
    if (!source) {
      throw new FatalError(
        `An alias was defined for ${rule.trait ? `${rule.trait}::` : ''}${rule.method} but this method does not exist`,
        decl.row
      );
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
  for (const contract of contracts) {
    const implementation = cls.findMethod(contract.lname);
    if (implementation) checkOverride(cls, implementation, contract);
  }
}

function applyTraitProperties(cls: PhpClass, trait: PhpClass, origins: Map<string, string>, row: number): void {
  for (const source of trait.props) {
    const prop = source.declarationAst;
    if (!prop) continue;
    const declarationScope = source.declarationScope ?? trait;
    const existing = cls.propByName.get(prop.name);
    if (existing && existing.cls === cls) {
      if (existing.hooks || prop.hooks)
        throw new FatalError(
          `${origins.get(prop.name) ?? cls.name} and ${trait.name} define the same hooked property ($${prop.name}) in the composition of ${cls.name}. Conflict resolution between hooked properties is currently not supported. Class was composed`,
          row
        );
      if (!traitPropertyCompatible(existing, prop, cls, declarationScope))
        throw new FatalError(
          `${origins.get(prop.name) ?? cls.name} and ${trait.name} define the same property ($${prop.name}) in the composition of ${cls.name}. However, the definition differs and is considered incompatible. Class was composed`,
          row
        );
      continue;
    }
    addProperty(cls, prop, declarationScope);
    origins.set(prop.name, trait.name);
  }
}

// code-gauge-allow functionCognitiveComplexity 18 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function traitPropertyCompatible(
  existing: PropDecl,
  property: PropertyDeclAst,
  cls: PhpClass,
  declarationScope: PhpClass
): boolean {
  if (
    existing.visibility !== property.visibility ||
    existing.isStatic !== property.isStatic ||
    existing.isReadonly !== property.isReadonly ||
    existing.isFinal !== (property.isFinal || property.setVisibility === 'private') ||
    existing.setVisibility !==
      (property.setVisibility ?? (property.isReadonly && property.visibility === 'public' ? 'protected' : undefined))
  )
    return false;
  if (Boolean(existing.type) !== Boolean(property.type)) return false;
  if (
    existing.type &&
    property.type &&
    !sameDeclarationType(existing.type, existing.declarationScope ?? existing.cls, property.type, declarationScope)
  )
    return false;
  const left = existing.defaultValue ? existing.defaultValue() : existing.type ? UNINIT : null;
  const right = property.defaultExpr ? evaluateInClass(property.defaultExpr, cls) : property.type ? UNINIT : null;
  return left === UNINIT || right === UNINIT ? left === right : strictEquals(left, right);
}

function allTraitMethods(trait: PhpClass): Map<string, Method> {
  return trait.methods;
}

function copyFunction(fn: Callable): Callable {
  if (fn.kind === 'native') return fn;
  return { ...fn, statics: new Map() };
}

// code-gauge-allow functionNcss 46 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function checkInheritance(cls: PhpClass, row: number): void {
  const ancestors: PhpClass[] = [];
  for (let parent = cls.parent; parent; parent = parent.parent) ancestors.push(parent);
  const inherited = new Map<string, Method>();
  for (const parent of ancestors.toReversed()) {
    for (const method of parent.methods.values()) inherited.set(method.lname, method);
  }
  const checked = new Set<string>();
  for (const parentMethod of inherited.values()) {
    const method = cls.methods.get(parentMethod.lname);
    if (method && parentMethod.visibility !== 'private') {
      checkOverride(cls, method, parentMethod);
      checked.add(method.lname);
    }
  }
  for (const iface of cls.interfaces) {
    for (const ifaceMethod of iface.methods.values()) {
      const own = cls.methods.get(ifaceMethod.lname);
      if (!own && cls.parent?.interfaces.includes(iface)) continue;
      const method = own ?? inherited.get(ifaceMethod.lname);
      if (method && ifaceMethod !== method) {
        checkOverride(cls, method, ifaceMethod, !checked.has(method.lname));
        checked.add(method.lname);
      }
    }
  }
  const hooks = missingPropertyHooks(cls, ancestors, row);
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
  if (missing.length > 0 || hooks.length > 0) {
    const allNames = [...missing.map((method) => `${method.cls.name}::${method.name}`), ...hooks];
    const names = allNames.slice(0, 3);
    const count = allNames.length;
    throw new FatalError(
      `Class ${cls.name} contains ${count} abstract method${count === 1 ? '' : 's'} and must therefore be declared abstract or implement the remaining method${count === 1 ? '' : 's'} (${names.join(', ')}${count > 3 ? ', ...' : ''})`,
      row
    );
  }
}

// code-gauge-allow functionCognitiveComplexity 29 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function missingPropertyHooks(cls: PhpClass, ancestors: PhpClass[], row: number): string[] {
  const missing = new Set<string>();
  const contracts = [...ancestors, ...cls.interfaces, cls].flatMap((parent) => [...parent.propByName.values()]);
  for (const contract of contracts) {
    if (!contract.hooks?.abstractGet && !contract.hooks?.abstractSet) continue;
    const property = cls.propByName.get(contract.name);
    if (property && property !== contract) {
      if (property.isStatic !== contract.isStatic)
        throw new FatalError(
          property.isStatic
            ? `Cannot redeclare non static ${contract.cls.name}::$${property.name} as static ${cls.name}::$${property.name}`
            : `Cannot redeclare static ${contract.cls.name}::$${property.name} as non static ${cls.name}::$${property.name}`,
          row
        );
      if (visibilityRank(property.visibility) < visibilityRank(contract.visibility))
        throw new FatalError(
          `Access level to ${cls.name}::$${property.name} must be ${contract.visibility} (as in class ${contract.cls.name})`,
          row
        );
      if (!propertyTypeCompatible(contract, property, property.cls))
        propertyTypeError(contract, cls, property.name, row);
    }
    for (const kind of ['get', 'set'] as const) {
      const required = kind === 'get' ? contract.hooks.abstractGet : contract.hooks.abstractSet;
      if (required && !implementsPropertyHook(property, kind))
        missing.add(`${contract.cls.name}::$${contract.name}::${kind}`);
    }
  }
  return [...missing];
}

function implementsPropertyHook(property: PropDecl | undefined, kind: 'get' | 'set'): boolean {
  if (!property || (kind === 'set' && property.isReadonly)) return false;
  if (property.isVirtual && !property.hooks?.[kind]) return false;
  return !(kind === 'get' ? property.hooks?.abstractGet : property.hooks?.abstractSet);
}

// code-gauge-allow functionCognitiveComplexity 21 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function checkOverride(cls: PhpClass, method: Method, parent: Method, reportTentative = true): void {
  if (parent.isFinal && method.cls === cls && !parent.cls.decl?.isAnonymous) {
    throw new FatalError(
      `Cannot override final method ${parent.cls.name}::${parent.name}()`,
      method.fn.kind === 'user' ? method.fn.decl.row : 0
    );
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
  const tentative =
    !parent.cls.isUser && tentativeReturnMethods.includes(lower(parent.scope.name + '::' + parent.name));
  if (!signatureCompatible(method, parent, tentative)) {
    throw new FatalError(
      `Declaration of ${signatureText(method)} must be compatible with ${signatureText(parent)}`,
      row
    );
  }
  if (tentative && reportTentative) {
    const expected = returnTypeOf(parent.fn);
    const actual = returnTypeOf(method.fn);
    if (expected && (!actual || !isSubtype(actual, method.cls, expected, parent.cls))) {
      const saved = rt().row;
      rt().row = row;
      try {
        deprecated(
          `Return type of ${signatureText(method)} should either be compatible with ${signatureText(parent)}, or the #[\\ReturnTypeWillChange] attribute should be used to temporarily suppress the notice`
        );
      } finally {
        rt().row = saved;
      }
    }
  }
}

/**
 * Whether a method may override another as PHP's inheritance check allows: it accepts every call the parent accepts
 * (parameters as many, as optional, and as wide in type) and returns only what the parent may return.
 */
// code-gauge-allow functionCognitiveComplexity 18 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function signatureCompatible(child: Method, parent: Method, skipReturn = false): boolean {
  if (
    parent.fn.kind === 'user' &&
    parent.fn.decl.byRefReturn &&
    (child.fn.kind !== 'user' || !child.fn.decl.byRefReturn)
  )
    return false;
  const childParams = child.fn.params;
  const parentParams = parent.fn.params;
  const childRequired = childParams.filter((param) => !param.optional && !param.variadic).length;
  if (childRequired > parentParams.filter((param) => !param.variadic).length) return false;
  for (const [index, param] of parentParams.entries()) {
    const own = childParams[index] ?? (childParams.at(-1)?.variadic ? childParams.at(-1) : undefined);
    if (!own || !paramCompatible(own, child.cls, param, parent.cls)) return false;
    if (
      param.variadic &&
      (!childParams.at(-1)?.variadic ||
        childParams.slice(index).some((own) => !paramCompatible(own, child.cls, param, parent.cls)))
    )
      return false;
  }
  if (skipReturn) return true;
  const parentReturn = returnTypeOf(parent.fn);
  const childReturn = returnTypeOf(child.fn);
  if (!parentReturn) return true;
  if (!childReturn) return parent.fn.kind !== 'user';
  return isSubtype(childReturn, child.cls, parentReturn, parent.cls);
}

function paramCompatible(own: Param, ownClass: PhpClass, param: Param, parentClass: PhpClass): boolean {
  if (param.byRef !== own.byRef) return false;
  if (param.optional && !own.optional && !own.variadic) return false;
  if (!own.type) return true;
  if (!param.type) return own.type.k === 'named' && own.type.name === 'mixed';
  return isSubtype(param.type, parentClass, own.type, ownClass);
}

function returnTypeOf(fn: Callable): TypeDecl | undefined {
  return fn.kind === 'user' ? fn.decl.returnType : fn.returnType;
}

// code-gauge-allow functionCognitiveComplexity 19 -- Follows PHP's class linking and property access rules in their order of checks.
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
        const defaultExpr =
          fn.kind === 'user' ? fn.decl.params.find((other) => other.name === param.name)?.defaultExpr : undefined;
        text += ` = ${defaultExpr ? defaultText(defaultExpr) : '<default>'}`;
      }
      return text;
    })
    .join(', ');
  const returnType = fn.kind === 'user' ? fn.decl.returnType : fn.returnType;
  return `${fn.kind === 'user' && fn.decl.byRefReturn ? '& ' : ''}${method.scope.name}::${method.name}(${params})${returnType ? `: ${typeToString(returnType)}` : ''}`;
}

function defaultText(e: Expr): string {
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
/**
 * Creates an object and runs its constructor. PHP creates the object before it evaluates the arguments (`args`), and
 * evaluates them even for a class without a constructor.
 */
export function instantiate(
  cls: PhpClass,
  args: () => ArgValue[],
  callRow: number,
  scope: PhpClass | undefined
): PhpObject {
  checkInstantiable(cls);
  const object = createObject(cls);
  rt().frame.temporaries.push(object);
  const constructor = cls.findMethod('__construct');
  if (constructor && !canCall(constructor, scope)) {
    throwError(
      'Error',
      `Call to ${constructor.visibility} ${constructor.scope.name}::__construct() from ${scope ? `scope ${scope.name}` : 'global scope'}`
    );
  }
  const values = args();
  if (constructor) {
    invoke(
      { fn: constructor.fn, thisObj: object, scope: constructor.scope, staticClass: cls, method: constructor },
      values,
      callRow
    );
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

// code-gauge-allow functionNcss 42 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
export function readProp(object: PhpObject, name: string, scope: PhpClass | undefined, quiet = false): Value {
  rt().spend();
  if (object.isResource) {
    if (!quiet) warn(`Attempt to read property "${name}" on resource`);
    return null;
  }
  const decl = lookupProp(object.cls, name, scope);
  if (decl && !decl.isStatic) {
    if (!canAccessProp(decl, scope)) {
      const magic = object.cls.findMethod('__get');
      if (magic && !object.guards?.has(`get:${name}`))
        return guarded(object, `get:${name}`, () => callMagic(object, magic, [name]));
      throwError('Error', `Cannot access ${decl.visibility} property ${object.cls.name}::$${name}`);
    }
    if (decl.hooks?.get && !object.guards?.has(`hook:${name}`)) {
      return guarded(object, `hook:${name}`, () =>
        invoke(
          { fn: decl.hooks?.get as Callable, thisObj: object, scope: decl.cls, staticClass: object.cls },
          [],
          rt().row
        )
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
      if (quiet) return null;
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
  if (magic && !object.guards?.has(`get:${name}`))
    return guarded(object, `get:${name}`, () => callMagic(object, magic, [name]));
  if (quiet) return null;
  if (decl?.isStatic) notice(`Accessing static property ${object.cls.name}::$${name} as non static`);
  warn(`Undefined property: ${object.cls.name}::$${name}`);
  return null;
}

// code-gauge-allow functionNcss 57 -- Follows PHP's class linking and property access rules in their order of checks.
export function writeProp(object: PhpObject, name: string, value: Value, scope: PhpClass | undefined): Value {
  if (object.isResource) throwError('Error', `Attempt to assign property "${name}" on resource`);
  rt().spend();
  const decl = lookupProp(object.cls, name, scope);
  if (decl && !decl.isStatic) {
    if (!canAccessProp(decl, scope)) {
      const magic = object.cls.findMethod('__set');
      if (magic && !object.guards?.has(`set:${name}`)) {
        guarded(object, `set:${name}`, () => callMagic(object, magic, [name, value]));
        return value;
      }
      throwError('Error', `Cannot access ${decl.visibility} property ${object.cls.name}::$${name}`);
    }
    if (decl.isReadonly) {
      const current = object.props.get(decl.key);
      const initialized = current !== UNINIT && current !== undefined;
      if (initialized && !object.cloning)
        throwError('Error', `Cannot modify readonly property ${decl.cls.name}::$${name}`);
      const outsideScope = !canWriteProp(decl, scope) || (scope !== decl.cls && !object.cloning);
      if (outsideScope && (scope === undefined || !scope.isSubclassOf(decl.cls))) {
        throwError(
          'Error',
          `Cannot modify ${readonlySetVisibility(decl)}(set) readonly property ${decl.cls.name}::$${name} from ${scopeText(scope)}`
        );
      }
      if (object.cloning) {
        object.readonlyInit ??= new Set();
        if (object.readonlyInit.has(decl.key))
          throwError('Error', `Cannot modify readonly property ${decl.cls.name}::$${name}`);
        object.readonlyInit.add(decl.key);
      }
    } else if (!canWriteProp(decl, scope)) {
      const visibility = decl.setVisibility ?? decl.visibility;
      throwError(
        'Error',
        `Cannot modify ${visibility}(set) property ${decl.cls.name}::$${name} from ${scopeText(scope)}`
      );
    }
    if (decl.hooks?.set && !object.guards?.has(`hook:${name}`)) {
      guarded(object, `hook:${name}`, () =>
        invoke(
          { fn: decl.hooks?.set as Callable, thisObj: object, scope: decl.cls, staticClass: object.cls },
          [{ v: value }],
          rt().row
        )
      );
      return value;
    }
    if (decl.isVirtual && decl.hooks && !decl.hooks.set) {
      throwError('Error', `Property ${object.cls.name}::$${name} is read-only`);
    }
    const coerced = decl.type ? coerceProperty(decl, value, object) : value;
    const slot = object.props.get(decl.key);
    if (slot instanceof Ref) slot.assign(coerced);
    else {
      object.props.set(decl.key, share(coerced));
      dropped(slot);
    }
    return slot instanceof Ref ? slot.v : coerced;
  }
  const slot = object.props.get(name);
  if (slot !== undefined) {
    if (slot instanceof Ref) slot.assign(value);
    else {
      object.props.set(name, share(value));
      dropped(slot);
    }
    return slot instanceof Ref ? slot.v : value;
  }
  const magic = object.cls.findMethod('__set');
  if (magic && !object.guards?.has(`set:${name}`)) {
    guarded(object, `set:${name}`, () => callMagic(object, magic, [name, value]));
    return value;
  }
  createDynamicProp(object, name);
  object.props.set(name, share(value));
  return value;
}

export function createDynamicProp(object: PhpObject, name: string): void {
  if (object.cls.isReadonly) throwError('Error', `Cannot create dynamic property ${object.cls.name}::$${name}`);
  if (object.cls.name !== 'stdClass' && !allowsDynamicProps(object.cls)) {
    deprecated(`Creation of dynamic property ${object.cls.name}::$${name} is deprecated`);
  }
}

function allowsDynamicProps(cls: PhpClass): boolean {
  for (let current: PhpClass | undefined = cls; current; current = current.parent) {
    if (current.name === 'stdClass' || current.name === 'Closure') return true;
  }
  return false;
}

/** Converts a value written to a typed property, or through a reference to one (`holder`), for its type. */
export function coerceProperty(decl: PropDecl, value: Value, object?: PhpObject, holder = 'property'): Value {
  const type = decl.type;
  if (!type) return value;
  const coerced = coerce(value, type, {
    strict: rt().strictTypes,
    internal: false,
    scope: decl.cls,
    staticClass: object?.cls,
  });
  if (coerced === NO_MATCH) {
    throwError(
      'TypeError',
      `Cannot assign ${valueName(value)} to ${holder} ${(object?.cls ?? decl.cls).name}::$${decl.name} of type ${describeType(type, decl.cls)}`
    );
  }
  return coerced;
}

/**
 * Throws PHP's error for changing a property through a reference or a nested write (`$o->list[] = 1`), which readonly
 * and asymmetric visibility forbid where a plain write would be forbidden.
 */
export function checkIndirectModification(object: PhpObject, name: string, scope: PhpClass | undefined): void {
  if (object.isResource) throwError('Error', `Attempt to modify property "${name}" on resource`);
  const decl = lookupProp(object.cls, name, scope);
  if (!decl || decl.isStatic) return;
  if (decl.isReadonly) {
    const slot = object.props.get(decl.key);
    const value = slot instanceof Ref ? slot.v : slot;
    if (value instanceof PhpObject) return;
    throwError('Error', `Cannot indirectly modify readonly property ${decl.cls.name}::$${name}`);
  } else if (!canWriteProp(decl, scope)) {
    throwError(
      'Error',
      `Cannot indirectly modify ${decl.setVisibility ?? decl.visibility}(set) property ${decl.cls.name}::$${name} from ${scopeText(scope)}`
    );
  }
}

/** The visibility of writing a readonly property, which is protected unless declared narrower, as since PHP 8.4. */
function readonlySetVisibility(decl: PropDecl): Visibility {
  return decl.setVisibility ?? (decl.visibility === 'public' ? 'protected' : decl.visibility);
}

/** The reference a property holds, creating it, for `=&`, by-reference arguments, and nested writes. */
// code-gauge-allow functionCognitiveComplexity 25 -- Follows PHP's class linking and property access rules in their order of checks.
// code-gauge-allow functionNcss 35 -- Follows PHP's class linking and property access rules in their order of checks.
export function propRef(
  object: PhpObject,
  name: string,
  scope: PhpClass | undefined,
  mode: 'alias' | 'foreach' = 'alias'
): Ref {
  if (object.isResource) throwError('Error', `Attempt to modify property "${name}" on resource`);
  const decl = lookupProp(object.cls, name, scope);
  const key = decl && !decl.isStatic ? decl.key : name;
  if (decl && !decl.isStatic && !canAccessProp(decl, scope)) {
    const overloaded = overloadedPropertyReference(object, name);
    if (overloaded) return overloaded;
    throwError('Error', `Cannot access ${decl.visibility} property ${object.cls.name}::$${name}`);
  }
  let slot = object.props.get(key);
  const value = slot instanceof Ref ? slot.v : slot;
  if (mode === 'foreach' && decl?.isReadonly)
    throwError('Error', `Cannot acquire reference to readonly property ${decl.cls.name}::$${name}`);
  if (decl?.isReadonly && value instanceof PhpObject) return Ref.temporary(value);
  checkIndirectModification(object, name, scope);
  if (slot instanceof Ref) return slot;
  if (slot === undefined && !decl) {
    const overloaded = overloadedPropertyReference(object, name);
    if (overloaded) return overloaded;
    createDynamicProp(object, name);
  }
  if (
    (slot === UNINIT || slot === undefined) &&
    decl?.type &&
    coerce(null, decl.type, { strict: true, internal: false, scope: decl.cls }) === NO_MATCH
  ) {
    throwError('Error', `Cannot access uninitialized non-nullable property ${decl.cls.name}::$${name} by reference`);
  }
  if (slot === UNINIT || slot === undefined) slot = null;
  const ref = new Ref(slot);
  ref.isRef = true;
  if (decl?.type && !decl.isStatic) ref.typedBy = [{ decl, object }];
  object.props.set(key, ref);
  return ref;
}

function overloadedPropertyReference(object: PhpObject, name: string): Ref | undefined {
  const magic = object.cls.findMethod('__get');
  if (!magic || object.guards?.has(`get:${name}`)) return;
  const runtime = rt();
  runtime.lastReturnRef = undefined;
  const value = guarded(object, `get:${name}`, () => callMagic(object, magic, [name]));
  const returned = runtime.lastReturnRef;
  runtime.lastReturnRef = undefined;
  if (returned) return returned;
  if (!(value instanceof PhpObject))
    notice(`Indirect modification of overloaded property ${object.cls.name}::$${name} has no effect`);
  return Ref.temporary(value);
}

// code-gauge-allow functionCognitiveComplexity 26 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
// code-gauge-allow functionNcss 34 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
export function bindPropertyReference(object: PhpObject, name: string, ref: Ref, scope: PhpClass | undefined): void {
  if (object.isResource) throwError('Error', `Attempt to modify property "${name}" on resource`);
  const decl = lookupProp(object.cls, name, scope);
  if ((!decl || !canAccessProp(decl, scope)) && object.cls.findMethod('__get')) {
    rt().lastReturnRef = undefined;
    const value = readProp(object, name, scope, true);
    if (!(value instanceof PhpObject) && !rt().lastReturnRef)
      notice(`Indirect modification of overloaded property ${object.cls.name}::$${name} has no effect`);
    rt().lastReturnRef = undefined;
    throwError('Error', 'Cannot assign by reference to overloaded object');
  }
  if (decl && !decl.isStatic) {
    if (!canAccessProp(decl, scope))
      throwError('Error', `Cannot access ${decl.visibility} property ${object.cls.name}::$${name}`);
    if (decl.isReadonly) {
      const slot = object.props.get(decl.key);
      const value = slot instanceof Ref ? slot.v : slot;
      throwError(
        'Error',
        value instanceof PhpObject
          ? 'Cannot assign by reference to overloaded object'
          : `Cannot indirectly modify readonly property ${decl.cls.name}::$${name}`
      );
    }
    checkIndirectModification(object, name, scope);
    if (decl.type) attachPropertyReference(ref, decl, object);
  } else if (!object.props.has(name)) createDynamicProp(object, name);
  const key = decl && !decl.isStatic ? decl.key : name;
  const old = object.props.get(key);
  if (old === ref) return;
  if (old instanceof Ref) old.rc--;
  ref.isRef = true;
  ref.rc++;
  object.props.set(key, ref);
  dropped(old);
}

export function attachPropertyReference(ref: Ref, decl: PropDecl, object?: PhpObject): void {
  const value = coerceProperty(decl, ref.v, object);
  const checked = checkReferenceValue(ref, value);
  if (!Object.is(checked, value)) {
    const source = ref.typedBy?.[0]?.decl;
    if (source)
      throwError(
        'TypeError',
        `Reference with value of type ${valueName(ref.v)} held by property ${source.cls.name}::$${source.name} of type ${describeType(source.type as TypeDecl, source.cls)} is not compatible with property ${decl.cls.name}::$${decl.name} of type ${describeType(decl.type as TypeDecl, decl.cls)}`
      );
  }
  ref.assign(value);
  ref.addTypeOwner(decl, object);
}

setReferenceTypeCheck(checkReferenceValue);

function checkReferenceValue(ref: Ref, value: Value): Value {
  const owners = ref.typeOwners();
  let coerced = value;
  for (const { decl, object } of owners) {
    coerced = coerceProperty(decl, coerced, object, 'reference held by property');
  }
  for (const { decl, object } of owners) {
    if (!Object.is(coerceProperty(decl, coerced, object, 'reference held by property'), coerced)) {
      throwError(
        'TypeError',
        `Cannot assign ${valueName(value)} to reference held by property ${decl.cls.name}::$${decl.name} of type ${describeType(decl.type as TypeDecl, decl.cls)}`
      );
    }
  }
  return coerced;
}

// code-gauge-allow functionCognitiveComplexity 21 -- Follows PHP's class linking and property access rules in their order of checks.
// code-gauge-allow functionNcss 34 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
export function unsetProp(object: PhpObject, name: string, scope: PhpClass | undefined): void {
  if (object.isResource) return;
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
    if (decl.isReadonly) throwError('Error', `Cannot unset readonly property ${decl.cls.name}::$${name}`);
    if (!canWriteProp(decl, scope))
      throwError(
        'Error',
        `Cannot unset ${decl.setVisibility ?? decl.visibility}(set) property ${decl.cls.name}::$${name} from ${scopeText(scope)}`
      );
    const slot = object.props.get(decl.key);
    if (slot instanceof Ref) slot.rc--;
    if (decl.type) object.props.set(decl.key, UNINIT);
    else object.props.delete(decl.key);
    dropped(slot);
    return;
  }
  if (object.props.has(name)) {
    const slot = object.props.get(name);
    if (slot instanceof Ref) slot.rc--;
    object.props.delete(name);
    dropped(slot);
    return;
  }
  const magic = object.cls.findMethod('__unset');
  if (magic) callMagic(object, magic, [name]);
}

// code-gauge-allow functionCognitiveComplexity 21 -- Follows PHP's class linking and property access rules in their order of checks.
export function issetProp(object: PhpObject, name: string, scope: PhpClass | undefined): boolean {
  if (object.isResource) return false;
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
  for (let current: PhpClass | undefined = cls; current; current = current.parent)
    if (current.name === name) return current;
  return undefined;
}

// Static members -----------------------------------------------------------------------------------------------------

/** A static property's reference, whose initial value is computed when the program first reads it. */
export type LazyRef = Ref & { lazy?: () => Value };

export function resolveStatic(ref: LazyRef): Ref {
  if (ref.lazy) {
    const lazy = ref.lazy;
    ref.lazy = undefined;
    try {
      ref.v = lazy();
    } catch (error) {
      ref.lazy = lazy;
      throw error;
    }
  }
  return ref;
}

export function staticPropRef(cls: PhpClass, name: string, scope: PhpClass | undefined): Ref {
  const found = cls.findStatic(name);
  if (!found) throwError('Error', `Access to undeclared static property ${cls.name}::$${name}`);
  if (!canAccessProp(found.decl, scope)) {
    throwError('Error', `Cannot access ${found.decl.visibility} property ${cls.name}::$${name}`);
  }
  const ref = resolveStatic(found.ref);
  if (found.decl.type) ref.addTypeOwner(found.decl);
  return ref;
}

export function bindStaticPropertyReference(cls: PhpClass, name: string, scope: PhpClass | undefined, ref: Ref): void {
  const old = staticPropRef(cls, name, scope);
  const found = cls.findStatic(name);
  if (!found || old === ref) return;
  if (found.decl.type) attachPropertyReference(ref, found.decl);
  ref.isRef = true;
  ref.rc++;
  old.rc--;
  found.decl.cls.staticProps.set(name, { ...found, ref });
  dropped(old.v);
}

export function readStaticProp(cls: PhpClass, name: string, scope: PhpClass | undefined, quiet = false): Value {
  if (quiet) {
    const found = cls.findStatic(name);
    if (!found || !canAccessProp(found.decl, scope)) return null;
  }
  const ref = staticPropRef(cls, name, scope);
  const value = ref.v;
  if ((value as unknown) === UNINIT) {
    if (quiet) return null;
    throwError('Error', `Typed static property ${cls.name}::$${name} must not be accessed before initialization`);
  }
  return value;
}

export function objectToArray(object: PhpObject): PhpArray {
  const array = new PhpArray();
  for (const [key, slot] of object.props) {
    if (slot === UNINIT) continue;
    const decl = declForKey(object.cls, key);
    let arrayKey = key;
    if (decl?.visibility === 'protected') arrayKey = `\0*\0${decl.name}`;
    array.setSlot(normalizeKeyString(arrayKey), copyValueSlot(slot));
  }
  return array;
}

export function requireClassScope(
  scope: PhpClass | undefined,
  word: 'self' | 'static' | 'parent',
  context: 'access' | 'className' = 'access'
): PhpClass {
  if (scope) return scope;
  throwError('Error', classScopeMessage(word, context));
}

export function classScopeMessage(
  word: 'self' | 'static' | 'parent',
  context: 'access' | 'className' = 'access'
): string {
  return context === 'className'
    ? `Cannot use "${word}" in the global scope`
    : `Cannot access "${word}" when no class scope is active`;
}
