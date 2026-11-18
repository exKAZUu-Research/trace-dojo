// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import type { ClassDecl, Expr, FunctionDecl, MethodDeclAst, PropertyDeclAst, TraitRule } from './ast';
import { canBindClass, declaresStringConversion } from './astAnalysis';
import builtinNames from './builtinNames.json';
import {
  addConst,
  applyTraitConstants,
  evaluateInClass,
  initializeClassConstants,
  linkInterfaceConstants,
} from './classConstants';
export { canAccessConstant, classConstant, setClassEvaluator } from './classConstants';
import { lower } from './bytes';
import { type ArgValue, asInternal, invoke } from './calls';
import { foldedConstant, selectConstantBranch } from './constantDefaults';
import { debugType, formatFloat, normalizeKeyString, toBool, valueName } from './conversions';
import { deprecated, notice, throwError, warn } from './errors';
import { strictEquals } from './operators';
import { share } from './places';
import { FatalError, rt, SCRIPT_PATH } from './runtime';
import tentativeReturnMethods from './tentativeReturnMethods.json';
import { coerce, describePropertyType, describeType, NO_MATCH, parameterType } from './types';
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
  return canBindClass(decl, (parent) => declared.has(parent) || findClass(parent)?.isUser === false);
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
  if (declaresStringConversion(decl) && !declared.some((name) => lower(name) === 'stringable')) {
    declared.push('Stringable');
  }
  for (const name of declared) {
    const iface = findClass(name);
    if (!iface) throwError('Error', `Interface "${name}" not found`);
    if (iface.kind !== 'interface') {
      throw new FatalError(`${decl.name} cannot implement ${iface.name} - it is not an interface`, row);
    }
    if (cls.ownInterfaces.includes(iface)) {
      const kind = cls.kind === 'interface' ? 'Interface' : 'Class';
      throw new FatalError(`${kind} ${cls.name} cannot implement previously implemented interface ${iface.name}`, row);
    }
    cls.ownInterfaces.push(iface);
  }
  cls.interfaces = linkInterfaces(cls.parent, cls.ownInterfaces);
  checkBuiltinInterfaces(cls, row);
  for (const use of decl.traits) {
    for (const name of use.names) {
      const trait = findClass(name);
      if (!trait) throwError('Error', `Trait "${name}" not found`);
      if (trait.kind !== 'trait') throwError('Error', `${decl.name} cannot use ${trait.name} - it is not a trait`);
      cls.traits.push(trait);
    }
  }
  for (const constant of decl.consts) addConst(cls, constant);
  addDeclaredProperties(cls, decl.props);
  for (const method of decl.methods) addMethod(cls, method);
  applyTraits(cls, decl);
  linkInterfaceConstants(cls, row);
  checkInheritance(cls, row);
  if (!decl.isAnonymous) runtime.classes.set(key, cls);
  runtime.userClasses.push(cls);
  return cls;
}

function checkBuiltinInterfaces(cls: PhpClass, row: number): void {
  if (cls.kind !== 'class') return;
  const implementsInterface = (name: string): boolean => cls.interfaces.some((iface) => lower(iface.name) === name);
  const iterator = implementsInterface('iterator');
  const aggregate = implementsInterface('iteratoraggregate');
  if (iterator && aggregate)
    throw new FatalError(
      `Class ${cls.name} cannot implement both Iterator and IteratorAggregate at the same time`,
      row
    );
  if (!cls.isAbstract && implementsInterface('traversable') && !iterator && !aggregate)
    throw new FatalError(
      `Class ${cls.name} must implement interface Traversable as part of either Iterator or IteratorAggregate`,
      -1
    );
  if (implementsInterface('throwable') && !cls.parent?.interfaces.some((iface) => lower(iface.name) === 'throwable'))
    throw new FatalError(
      `Class ${cls.name} cannot implement interface Throwable, extend Exception or Error instead`,
      row
    );
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
  cls.compare = parent.compare;
}

function propertyKey(cls: PhpClass, name: string, visibility: Visibility): string {
  return visibility === 'private' ? `\0${cls.name}\0${name}` : name;
}

function addDeclaredProperties(cls: PhpClass, properties: PropertyDeclAst[]): void {
  if (cls.parent) {
    const byName = new Map(properties.map((property) => [property.name, property]));
    for (const inherited of cls.parent.propByName.values()) {
      const property = byName.get(inherited.name);
      if (property) checkPropertyOverride(cls, inherited, property, cls);
    }
  }
  for (const property of properties) addProperty(cls, property);
}

// code-gauge-allow functionCognitiveComplexity 24 -- Applies PHP property override checks in diagnostic order.
function checkPropertyOverride(
  cls: PhpClass,
  inherited: PropDecl,
  ast: PropertyDeclAst,
  declarationScope: PhpClass
): void {
  if (inherited.isFinal)
    throw new FatalError(`Cannot override final property ${inherited.cls.name}::$${ast.name}`, cls.declaredRow);
  if (inherited.visibility === 'private') return;
  if (inherited.isStatic !== ast.isStatic) {
    throw new FatalError(
      ast.isStatic
        ? `Cannot redeclare non static ${inherited.cls.name}::$${ast.name} as static ${cls.name}::$${ast.name}`
        : `Cannot redeclare static ${inherited.cls.name}::$${ast.name} as non static ${cls.name}::$${ast.name}`,
      cls.declaredRow
    );
  }
  if (visibilityRank(ast.visibility) < visibilityRank(inherited.visibility)) {
    throw new FatalError(
      `Access level to ${cls.name}::$${ast.name} must be ${inherited.visibility === 'public' ? 'public' : 'protected'} (as in class ${inherited.cls.name})${inherited.visibility === 'protected' ? ' or weaker' : ''}`,
      cls.declaredRow
    );
  }
  if (inherited.isReadonly !== ast.isReadonly)
    throw new FatalError(
      `Cannot redeclare ${inherited.isReadonly ? 'readonly' : 'non-readonly'} property ${inherited.cls.name}::$${ast.name} as ${ast.isReadonly ? 'readonly' : 'non-readonly'} ${cls.name}::$${ast.name}`,
      cls.declaredRow
    );
  const setter = effectiveSetVisibility(ast);
  const parentSetter = effectiveSetVisibility(inherited);
  if (visibilityRank(setter) < visibilityRank(parentSetter)) {
    throw new FatalError(
      `Set access level of ${cls.name}::$${ast.name} must be ${parentSetter === 'public' ? 'omitted' : `${parentSetter}(set)`} (as in class ${inherited.cls.name})${parentSetter === 'protected' ? ' or weaker' : ''}`,
      cls.declaredRow
    );
  }
  if (inherited.type && !propertyTypeCompatible(inherited, ast, cls, declarationScope)) {
    propertyTypeError(inherited, cls, ast.name, cls.declaredRow);
  }
  if (!inherited.type && ast.type && !propertyTypeCompatible(inherited, ast, cls, declarationScope)) {
    throw new FatalError(
      `Type of ${cls.name}::$${ast.name} must not be defined (as in class ${inherited.cls.name})`,
      cls.declaredRow
    );
  }
}

// code-gauge-allow functionCognitiveComplexity 27 -- Populates property slots, defaults and hooks together.
// code-gauge-allow functionNcss 35 -- The storage variants share property metadata and defaults.
function addProperty(cls: PhpClass, ast: PropertyDeclAst, declarationScope = cls): void {
  const inherited = cls.propByName.get(ast.name);
  if (ast.isFinal && ast.visibility === 'private' && !ast.promoted)
    throw new FatalError('Property cannot be both final and private', ast.row);
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
  const parent = inherited?.cls !== cls && inherited?.visibility !== 'private' ? inherited : undefined;
  linkPropertyHooks(decl, ast, parent);
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
  if (index !== -1) cls.props[index] = decl;
  else cls.props.push(decl);
  cls.propByName.set(ast.name, decl);
  if (decl.visibility === 'private') cls.privateProps.set(ast.name, decl);
}

// code-gauge-allow functionCognitiveComplexity 25 -- Keeps the ordered PHP cases together because each branch shares the same dispatch state.
function linkPropertyHooks(decl: PropDecl, ast: PropertyDeclAst, parent: PropDecl | undefined): void {
  const own = ast.hooks;
  const inherited = parent?.hooks;
  if (!own && !inherited) return;
  if (own?.get && inherited?.finalGet)
    throw new FatalError(
      `Cannot override final property hook ${(inherited.getScope ?? parent?.cls)?.name}::$${ast.name}::get()`,
      decl.cls.declaredRow
    );
  if (own?.set && inherited?.finalSet)
    throw new FatalError(
      `Cannot override final property hook ${(inherited.setScope ?? parent?.cls)?.name}::$${ast.name}::set()`,
      decl.cls.declaredRow
    );
  const cls = decl.cls;
  const parameter = own?.set?.params[0];
  if (ast.type && parameter?.type && !isSubtype(ast.type, cls, parameter.type, cls))
    throw new FatalError(
      `Type of parameter $${parameter.name} of hook ${cls.name}::$${ast.name}::set must be compatible with property type`,
      ast.row
    );
  const get = own?.get ? hookFunction(own.get) : inherited?.abstractGet ? undefined : inherited?.get;
  const set = own?.set ? hookFunction(own.set) : inherited?.abstractSet ? undefined : inherited?.set;
  if (!get && !set) return;
  decl.hooks = {
    get,
    set,
    getScope: own?.get ? cls : (inherited?.getScope ?? parent?.cls),
    setScope: own?.set ? cls : (inherited?.setScope ?? parent?.cls),
    getBacking: own?.get ? own.getBacking : inherited?.getBacking,
    setBacking: own?.set ? own.setBacking : inherited?.setBacking,
    finalGet: own?.get ? own.finalGet : inherited?.finalGet,
    finalSet: own?.set ? own.finalSet : inherited?.finalSet,
    abstractGet: own?.abstractGet,
    abstractSet: own?.abstractSet,
  };
  decl.isVirtual = ast.isVirtual && !decl.hooks.getBacking && !decl.hooks.setBacking;
  if (decl.isVirtual && ast.defaultExpr)
    throw new FatalError(`Cannot specify default value for virtual hooked property ${cls.name}::$${ast.name}`, ast.row);
}

function propertyTypeCompatible(
  parent: PropDecl,
  child: Pick<PropertyDeclAst, 'type'>,
  cls: PhpClass,
  declarationScope = cls
): boolean {
  if (
    parent.type &&
    child.type &&
    parent.declarationScope?.kind === 'trait' &&
    declarationScope.kind === 'trait' &&
    sameDeclarationType(parent.type, parent.declarationScope, child.type, declarationScope)
  )
    return true;
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
      `Cannot use ${debugType(value)} as default value for property ${decl.cls.name}::$${decl.name} of type ${describePropertyType(decl)}`,
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
// code-gauge-allow functionCognitiveComplexity 25 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function applyTraits(cls: PhpClass, decl: ClassDecl): void {
  if (cls.traits.length === 0) return;
  const rules = decl.traits.flatMap((use) => use.rules);
  const excluded = traitPrecedence(cls, rules, decl.row);
  const aliases = rules
    .filter((rule) => rule.k === 'as')
    .map((rule) => ({ rule, source: traitAliasSource(cls, rule, decl.row) }));
  const ownMethods = new Set(decl.methods.map((method) => lower(method.fn.name)));
  const added = new Map<string, PhpClass>();
  const contracts: Method[] = [];
  const propertyOrigins = new Map<string, string>();
  const constantOrigins = new Map<string, string>();
  for (const trait of cls.traits) {
    for (const [lname, method] of trait.methods) {
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
  for (const { rule, source } of aliases) applyTraitAlias(cls, rule, source, ownMethods, added);
  for (const contract of contracts) {
    const implementation = cls.findMethod(contract.lname);
    if (implementation) checkOverride(cls, implementation, contract);
  }
}

function applyTraitAlias(
  cls: PhpClass,
  rule: Extract<TraitRule, { k: 'as' }>,
  source: PhpClass,
  ownMethods: Set<string>,
  added: Map<string, PhpClass>
): void {
  const name = lower(rule.method);
  const method = source.methods.get(name) as Method;
  if (rule.alias) {
    const lname = lower(rule.alias);
    if (ownMethods.has(lname)) return;
    cls.methods.set(lname, {
      ...method,
      name: rule.alias,
      lname,
      cls,
      scope: cls,
      visibility: rule.visibility ?? method.visibility,
      fn: copyFunction(method.fn),
    });
  } else if (rule.visibility && added.get(name) === source) {
    const own = cls.methods.get(name);
    if (own) cls.methods.set(name, { ...own, visibility: rule.visibility });
  }
}

function traitPrecedence(cls: PhpClass, rules: TraitRule[], row: number): Set<string> {
  const excluded = new Set<string>();
  for (const rule of rules) {
    if (rule.k !== 'insteadof') continue;
    const trait = usedTrait(cls, rule.trait, row);
    const method = lower(rule.method);
    if (!trait.methods.has(method))
      throw new FatalError(
        `A precedence rule was defined for ${trait.name}::${rule.method} but this method does not exist`,
        row
      );
    for (const name of rule.instead) {
      const other = usedTrait(cls, name, row);
      const key = `${lower(other.name)}::${method}`;
      if (excluded.has(key))
        throw new FatalError(
          `Failed to evaluate a trait precedence (${rule.method}). Method of trait ${other.name} was defined to be excluded multiple times`,
          row
        );
      if (other === trait)
        throw new FatalError(
          `Inconsistent insteadof definition. The method ${rule.method} is to be used from ${trait.name}, but ${trait.name} is also on the exclude list`,
          row
        );
      excluded.add(key);
    }
  }
  return excluded;
}

function traitAliasSource(cls: PhpClass, rule: Extract<TraitRule, { k: 'as' }>, row: number): PhpClass {
  const name = lower(rule.method);
  if (rule.trait) {
    const trait = usedTrait(cls, rule.trait, row);
    if (!trait.methods.has(name))
      throw new FatalError(
        `An alias was defined for ${trait.name}::${rule.method} but this method does not exist`,
        row
      );
    return trait;
  }
  const [first, second] = [...new Set(cls.traits)].filter((trait) => trait.methods.has(name));
  if (second)
    throw new FatalError(
      `An alias was defined for method ${rule.method}(), which exists in both ${first.name} and ${second.name}. Use ${first.name}::${rule.method} or ${second.name}::${rule.method} to resolve the ambiguity`,
      row
    );
  if (first) return first;
  const message = rule.alias
    ? `An alias (${rule.alias}) was defined for method ${rule.method}(), but this method does not exist`
    : `The modifiers of the trait method ${rule.method}() are changed, but this method does not exist. Error`;
  throw new FatalError(message, row);
}

function usedTrait(cls: PhpClass, name: string, row: number): PhpClass {
  const trait = findClass(name);
  if (!trait) throw new FatalError(`Could not find trait ${name}`, row);
  if (trait.kind !== 'trait')
    throw new FatalError(
      `Class ${trait.name} is not a trait, Only traits may be used in 'as' and 'insteadof' statements`,
      row
    );
  if (!cls.traits.includes(trait))
    throw new FatalError(`Required Trait ${trait.name} wasn't added to ${cls.name}`, row);
  return trait;
}

// code-gauge-allow functionCognitiveComplexity 16 -- Checks same-name properties before linking trait properties.
function applyTraitProperties(cls: PhpClass, trait: PhpClass, origins: Map<string, string>, row: number): void {
  for (const source of trait.propByName.values()) {
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
    const inherited = cls.propByName.get(prop.name);
    if (inherited && inherited.cls !== cls) checkPropertyOverride(cls, inherited, prop, declarationScope);
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

function copyFunction(fn: Callable): Callable {
  if (fn.kind === 'native') return fn;
  return { ...fn, statics: new Map() };
}

// code-gauge-allow functionNcss 48 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
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
    const methods = count === 1 ? 'method' : 'methods';
    const requirement = cls.isAnonymous
      ? `must implement ${count} abstract ${methods}`
      : `contains ${count} abstract ${methods} and must therefore be declared abstract or implement the remaining ${methods}`;
    throw new FatalError(`Class ${cls.name} ${requirement} (${names.join(', ')}${count > 3 ? ', ...' : ''})`, row);
  }
}

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
      if (
        contract.hooks.abstractSet &&
        visibilityRank(effectiveSetVisibility(property)) < visibilityRank(effectiveSetVisibility(contract))
      ) {
        const setter = effectiveSetVisibility(contract);
        throw new FatalError(
          `Set access level of ${cls.name}::$${property.name} must be ${setter === 'public' ? 'omitted' : `${setter}(set)`} (as in class ${contract.cls.name})${setter === 'protected' ? ' or weaker' : ''}`,
          row
        );
      }
      if (cls.kind === 'interface') checkInterfaceHooks(contract, property, row);
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

// code-gauge-allow functionCognitiveComplexity 22 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function checkInterfaceHooks(parent: PropDecl, child: PropDecl, row: number): void {
  for (const kind of ['get', 'set'] as const) {
    const inherited = parent.hooks?.[kind];
    const own = child.hooks?.[kind];
    if (!inherited || !own) continue;
    const parentType = kind === 'set' ? (inherited.params[0]?.type ?? parent.type) : parent.type;
    const childType = kind === 'set' ? (own.params[0]?.type ?? child.type) : child.type;
    const mixed: TypeDecl = { k: 'named', name: 'mixed' };
    const compatible =
      kind === 'get'
        ? isSubtype(childType ?? mixed, child.cls, parentType ?? mixed, parent.cls)
        : isSubtype(parentType ?? mixed, parent.cls, childType ?? mixed, child.cls);
    if (compatible) continue;
    const signature = (prop: PropDecl, fn: Callable, type: TypeDecl | undefined): string => {
      const prefix = `${prop.cls.name}::$${prop.name}::${kind}`;
      if (kind === 'get') return `${prefix}()${type ? `: ${describeType(type, prop.cls)}` : ''}`;
      return `${prefix}(${type ? `${describeType(type, prop.cls)} ` : ''}$${fn.params[0]?.name ?? 'value'}): void`;
    };
    throw new FatalError(
      `Declaration of ${signature(child, own, childType)} must be compatible with ${signature(parent, inherited, parentType)}`,
      row
    );
  }
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
  const ownType = parameterType(own);
  if (!ownType) return true;
  const paramType = parameterType(param);
  if (!paramType) return ownType.k === 'named' && ownType.name === 'mixed';
  return isSubtype(paramType, parentClass, ownType, ownClass);
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
      const type = parameterType(param);
      if (type) text += `${describeType(type, method.scope)} `;
      if (param.byRef) text += '&';
      if (param.variadic) text += '...';
      text += `$${param.name}`;
      if (param.optional && !param.variadic) {
        const defaultExpr =
          fn.kind === 'user' ? fn.decl.params.find((other) => other.name === param.name)?.defaultExpr : undefined;
        text += ` = ${defaultExpr ? defaultText(defaultExpr, method) : (param.nativeDefault ?? '<default>')}`;
      }
      return text;
    })
    .join(', ');
  const returnType = fn.kind === 'user' ? fn.decl.returnType : fn.returnType;
  return `${fn.kind === 'user' && fn.decl.byRefReturn ? '& ' : ''}${method.scope.name}::${method.name}(${params})${returnType ? `: ${describeType(returnType, method.scope)}` : ''}`;
}

// code-gauge-allow functionCognitiveComplexity 28 -- Keeps the ordered PHP cases together because each branch shares the same dispatch state.
function defaultText(expression: Expr, method: Method): string {
  const declaringName = method.fn.kind === 'user' ? method.fn.decl.className : undefined;
  const traitDeclaration =
    method.scope.kind === 'trait' || (declaringName && findClass(declaringName)?.kind === 'trait');
  const context = {
    budget: rt(),
    preserveNamedConstants: true,
    className: (ref: Extract<Expr, { k: 'cconst' }>['cls']): string | undefined => {
      if (traitDeclaration) return undefined;
      if (ref.k === 'self') return method.scope.fullName;
      return ref.k === 'parent' ? method.scope.parent?.fullName : undefined;
    },
  };
  const e = selectConstantBranch(expression, context);
  const value =
    e.k === 'magic' && !(traitDeclaration && e.name === '__CLASS__')
      ? methodMagicDefault(e.name, method)
      : foldedConstant(e, context);
  if (value instanceof Map) return value.size === 0 ? '[]' : '[...]';
  if (typeof value === 'string') return `'${value.slice(0, 10)}${value.length > 10 ? '...' : ''}'`;
  if (typeof value === 'number') return formatFloat(value);
  if (value !== undefined) return String(value);
  if (e.k === 'const') return e.name.name;
  if (e.k === 'cconst' && e.className && traitDeclaration && (e.cls.k === 'self' || e.cls.k === 'parent'))
    return '<expression>';
  if (e.k === 'cconst' && e.cls.k !== 'expr' && typeof e.name === 'string')
    return `${e.cls.k === 'named' ? e.cls.name : e.cls.k}::${e.name}`;
  return '<expression>';
}

function methodMagicDefault(name: Extract<Expr, { k: 'magic' }>['name'], method: Method): string | undefined {
  const className = (method.fn.kind === 'user' ? method.fn.decl.className : undefined) ?? method.scope.name;
  switch (name) {
    case '__CLASS__': {
      return method.scope.kind === 'trait' ? undefined : method.scope.name;
    }
    case '__FUNCTION__': {
      return method.fn.name;
    }
    case '__METHOD__': {
      return `${className}::${method.fn.name}`;
    }
    case '__TRAIT__': {
      return className && findClass(className)?.kind === 'trait' ? className : '';
    }
  }
}

// Objects ------------------------------------------------------------------------------------------------------------

/** Creates an object of a class with its properties' initial values, without calling the constructor. */
export function createObject(cls: PhpClass): PhpObject {
  const runtime = rt();
  initializeClassDefaults(cls);
  const object = runtime.newObject(cls);
  initializeObjectProperties(object);
  if (cls.createInternal) object.internal = cls.createInternal(object);
  return object;
}

export function initializeObjectProperties(object: PhpObject): void {
  for (const decl of object.cls.props) {
    if (decl.isVirtual && decl.hooks) continue;
    let value: Slot;
    if (decl.defaultValue) value = decl.defaultValue();
    else value = decl.type ? UNINIT : null;
    object.props.set(decl.key, value);
  }
}

function checkInstantiable(cls: PhpClass): void {
  if (cls.name === 'Closure') rejectClosureInstantiation(cls);
  if (cls.kind === 'interface') throwError('Error', `Cannot instantiate interface ${cls.name}`);
  if (cls.kind === 'trait') throwError('Error', `Cannot instantiate trait ${cls.name}`);
  if (cls.kind === 'enum') throwError('Error', `Cannot instantiate enum ${cls.name}`);
  if (cls.isAbstract) throwError('Error', `Cannot instantiate abstract class ${cls.name}`);
}

function rejectClosureInstantiation(cls: PhpClass): never {
  const runtime = rt();
  const temporaries = runtime.frame.temporaries;
  const index = temporaries.length;
  const object = runtime.newObject(cls);
  try {
    throwError('Error', 'Instantiation of class Closure is not allowed');
  } finally {
    temporaries.splice(index, 1);
    runtime.freeObject(object);
  }
}

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
  try {
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
  } catch (error) {
    if (!object.destructed) {
      if (cls.findMethod('__destruct')) rt().destructibles--;
      object.destructed = true;
    }
    throw error;
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
  const declaration = cls.propByName.get(name);
  return declaration?.visibility === 'private' && declaration.cls !== cls ? undefined : declaration;
}

export function canAccessProp(decl: PropDecl, scope: PhpClass | undefined): boolean {
  if (decl.visibility === 'public') return true;
  if (!scope) return false;
  if (decl.visibility === 'private') return scope === decl.cls;
  return scope.isSubclassOf(rootPropDeclarer(decl)) || rootPropDeclarer(decl).isSubclassOf(scope);
}

export function canWriteProp(decl: PropDecl, scope: PhpClass | undefined): boolean {
  const visibility = effectiveSetVisibility(decl);
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
function callMagic(object: PhpObject, method: Method, args: Value[], internal = false): Value {
  return invoke(
    { fn: method.fn, thisObj: object, scope: method.scope, staticClass: object.cls, method },
    args.map((v) => ({ v })),
    internal ? undefined : rt().row
  );
}

function guarded<T>(object: PhpObject, key: string, run: () => T): T {
  object.guards ??= new Set();
  object.guards.add(key);
  try {
    return run();
  } finally {
    object.guards.delete(key);
  }
}

// code-gauge-allow functionNcss 47 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
export function readProp(
  object: PhpObject,
  name: string,
  scope: PhpClass | undefined,
  mode: 'read' | 'quiet' | 'update' | 'coalesce' | 'empty' | 'native' = 'read'
): Value {
  const quiet = mode !== 'read';
  rt().spend();
  if (object.isResource) {
    if (!quiet) warn(`Attempt to read property "${name}" on resource`);
    return null;
  }
  const decl = lookupProp(object.cls, name, scope);
  checkStaticInstanceAccess(
    object,
    name,
    scope,
    decl,
    mode === 'empty' || mode === 'coalesce' ? 'quiet' : 'get',
    !quiet
  );
  if (decl && !decl.isStatic) {
    if (!canAccessProp(decl, scope)) {
      const overloaded = readOverloadedProp(object, name, mode);
      if (overloaded !== undefined) return overloaded;
      if (mode === 'coalesce' || mode === 'empty') return null;
      throwError('Error', `Cannot access ${decl.visibility} property ${object.cls.name}::$${name}`);
    }
    const inHook = isBackingAccess(object, decl, 'read');
    if (decl.hooks?.get && !inHook) {
      const get = decl.hooks.get;
      const target = { fn: get, thisObj: object, scope: decl.hooks.getScope ?? decl.cls, staticClass: object.cls };
      return guarded(object, `hook:${name}`, () =>
        mode === 'native' ? asInternal(() => invoke(target, [], undefined)) : invoke(target, [], rt().row)
      );
    }
    requireVirtualPropertyHook(object, decl, 'get');
    const slot = object.props.get(decl.key);
    if (slot === undefined || slot === UNINIT) {
      if (slot === undefined || object.unsetProperties?.has(decl.key)) {
        const overloaded = readOverloadedProp(object, name, mode, decl);
        if (overloaded !== undefined) return overloaded;
      }
      if (quiet && mode !== 'update') return null;
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
  const overloaded = readOverloadedProp(object, name, mode);
  if (overloaded !== undefined) return overloaded;
  if (quiet) return null;
  warn(`Undefined property: ${object.cls.name}::$${name}`);
  return null;
}

function readOverloadedProp(
  object: PhpObject,
  name: string,
  mode: Parameters<typeof readProp>[3],
  unset?: PropDecl
): Value | undefined {
  const isset = mode === 'coalesce' || mode === 'empty' ? object.cls.findMethod('__isset') : undefined;
  if (isset && !object.guards?.has(`isset:${name}`)) {
    const present = (): boolean => toBool(callMagic(object, isset, [name]));
    if (mode === 'empty')
      return guarded(object, `isset:${name}`, () => (present() ? readOverloadedProp(object, name, 'quiet') : null));
    if (!guarded(object, `isset:${name}`, present)) return null;
  }
  if (mode === 'empty') return null;
  const magic = object.cls.findMethod('__get');
  if (!magic || object.guards?.has(`get:${name}`)) return;
  const value = guarded(object, `get:${name}`, () => callMagic(object, magic, [name], mode === 'native'));
  return checkUnsetGetterValue(value, unset, rt().lastReturnRef);
}

function checkUnsetGetterValue(value: Value, unset: PropDecl | undefined, returned: Ref | undefined): Value {
  if (!unset?.type) return value;
  const result = coerce(value, unset.type, { strict: rt().strictTypes, internal: false, scope: unset.cls });
  if (result === NO_MATCH)
    throwError(
      'TypeError',
      `Value of type ${typeof value === 'boolean' ? 'bool' : valueName(value)} returned from ${unset.cls.name}::__get() must be compatible with unset property ${unset.cls.name}::$${unset.name} of type ${describePropertyType(unset)}`
    );
  returned?.assign(result);
  return result;
}

// code-gauge-allow functionNcss 58 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
export function writeProp(
  object: PhpObject,
  name: string,
  value: Value,
  scope: PhpClass | undefined,
  options: { fetched?: boolean; operation?: 'assignOp' } = {}
): Value {
  if (object.isResource) throwError('Error', `Attempt to assign property "${name}" on resource`);
  const runtime = rt();
  const pending = runtime.pendingAssignmentWarning;
  runtime.spend();
  const decl = lookupProp(object.cls, name, scope);
  checkStaticInstanceAccess(object, name, scope, decl, 'set', !options.fetched);
  if (decl && !decl.isStatic) {
    if (!canAccessProp(decl, scope)) {
      if (writeOverloadedProperty(object, name, value)) return value;
      throwError('Error', `Cannot access ${decl.visibility} property ${object.cls.name}::$${name}`);
    }
    if (object.unsetProperties?.has(decl.key) && writeOverloadedProperty(object, name, value)) return value;
    if (decl.isReadonly) {
      const current = object.props.get(decl.key);
      if (current !== UNINIT && current !== undefined && !object.cloning)
        throwError('Error', `Cannot modify readonly property ${decl.cls.name}::$${name}`);
    }
    if (!canWriteProp(decl, scope))
      throwError(
        'Error',
        `Cannot modify ${setterAccessLabel(decl)} property ${decl.cls.name}::$${name} from ${scopeText(scope)}`
      );
    if (decl.isReadonly && object.cloning) {
      object.readonlyInit ??= new Set();
      if (object.readonlyInit.has(decl.key))
        throwError('Error', `Cannot modify readonly property ${decl.cls.name}::$${name}`);
      object.readonlyInit.add(decl.key);
    }
    const inHook = isBackingAccess(object, decl, 'write');
    if (decl.hooks?.set && !inHook) {
      if (pending) throw pending;
      guarded(object, `hook:${name}`, () =>
        invoke(
          {
            fn: decl.hooks?.set as Callable,
            thisObj: object,
            scope: decl.hooks?.setScope ?? decl.cls,
            staticClass: object.cls,
          },
          [{ v: value }],
          rt().row
        )
      );
      return value;
    }
    requireVirtualPropertyHook(object, decl, 'set');
    const slot = object.props.get(decl.key);
    const referenceUpdate = options.operation === 'assignOp' && slot instanceof Ref && slot.isRef;
    const coerced = decl.type && !referenceUpdate ? coerceProperty(decl, value, object) : value;
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
  if (writeOverloadedProperty(object, name, value)) return value;
  createDynamicProp(object, name, share(value));
  return value;
}

function writeOverloadedProperty(object: PhpObject, name: string, value: Value): boolean {
  const magic = object.cls.findMethod('__set');
  if (!magic || object.guards?.has(`set:${name}`)) return false;
  const pending = rt().pendingAssignmentWarning;
  if (pending) throw pending;
  guarded(object, `set:${name}`, () => callMagic(object, magic, [name, value]));
  return true;
}

export function createDynamicProp(object: PhpObject, name: string, value: Slot = null, deprecate = deprecated): void {
  if (object.cls.isReadonly || object.cls.name === 'Closure')
    throwError('Error', `Cannot create dynamic property ${object.cls.name}::$${name}`);
  try {
    if (object.cls.name !== 'stdClass' && !allowsDynamicProps(object.cls))
      deprecate(`Creation of dynamic property ${object.cls.name}::$${name} is deprecated`);
  } finally {
    if (!object.props.has(name)) object.props.set(name, value);
  }
}

function allowsDynamicProps(cls: PhpClass): boolean {
  for (let current: PhpClass | undefined = cls; current; current = current.parent) {
    if (current.name === 'stdClass') return true;
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
    const pending = rt().pendingAssignmentWarning;
    if (pending) throw pending;
    throwError(
      'TypeError',
      `Cannot assign ${valueName(value)} to ${holder} ${decl.cls.name}::$${decl.name} of type ${describePropertyType(decl)}`
    );
  }
  return coerced;
}

/** Checks indirect writes and returns an object value that can be mutated without exposing its property slot. */
// code-gauge-allow functionCognitiveComplexity 24 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
export function checkIndirectModification(
  object: PhpObject,
  name: string,
  scope: PhpClass | undefined,
  mode: 'write' | 'update' | 'unset' = 'write'
): PhpObject | undefined {
  if (object.isResource) throwError('Error', `Attempt to modify property "${name}" on resource`);
  const decl = lookupProp(object.cls, name, scope);
  if (!decl || decl.isStatic) return;
  if (!canAccessProp(decl, scope))
    throwError('Error', `Cannot access ${decl.visibility} property ${object.cls.name}::$${name}`);
  if (decl.hooks && !decl.hooks.get && !isBackingAccess(object, decl, 'write')) {
    const value = readProp(object, name, scope, 'update');
    if (value instanceof PhpObject && !value.isResource) return value;
    throwError('Error', `Indirect modification of ${decl.cls.name}::$${name} is not allowed`);
  }
  if (!decl.isReadonly && canWriteProp(decl, scope)) return;
  const slot = object.props.get(decl.key);
  const value = slot instanceof Ref ? slot.v : slot;
  if (value instanceof PhpObject && !value.isResource) return value;
  if (value === UNINIT || value === undefined) {
    if (mode === 'unset') return;
    if (decl.isReadonly && mode === 'update') readProp(object, name, scope);
  }
  if (decl.isReadonly) throwError('Error', `Cannot indirectly modify readonly property ${decl.cls.name}::$${name}`);
  throwError(
    'Error',
    `Cannot indirectly modify ${setterAccessLabel(decl)} property ${decl.cls.name}::$${name} from ${scopeText(scope)}`
  );
}

function effectiveSetVisibility(property: Pick<PropDecl, 'visibility' | 'setVisibility' | 'isReadonly'>): Visibility {
  return (
    property.setVisibility ??
    (property.isReadonly && property.visibility === 'public' ? 'protected' : property.visibility)
  );
}

function setterAccessLabel(property: PropDecl): string {
  const visibility = effectiveSetVisibility(property);
  return `${visibility}(set)${property.isReadonly && visibility !== 'private' ? ' readonly' : ''}`;
}

export function checkStaticInstanceAccess(
  object: PhpObject,
  name: string,
  scope: PhpClass | undefined,
  decl: PropDecl | undefined,
  operation: 'get' | 'set' | 'unset' | 'quiet',
  report = true
): boolean {
  if (!decl?.isStatic || operation === 'quiet') return false;
  if (object.cls.findMethod(`__${operation}`) && !object.guards?.has(`${operation}:${name}`)) return false;
  if (!canAccessProp(decl, scope))
    throwError('Error', `Cannot access ${decl.visibility} property ${object.cls.name}::$${name}`);
  if (report) notice(`Accessing static property ${object.cls.name}::$${name} as non static`);
  return report;
}

/** The reference a property holds, creating it, for `=&`, by-reference arguments, and nested writes. */
// code-gauge-allow functionNcss 47 -- Follows PHP's class linking and property access rules in their order of checks.
export function propRef(
  object: PhpObject,
  name: string,
  scope: PhpClass | undefined,
  mode: 'alias' | 'foreach' = 'alias',
  reportedStatic = false
): Ref {
  if (object.isResource) throwError('Error', `Attempt to modify property "${name}" on resource`);
  const property = lookupProp(object.cls, name, scope);
  checkStaticInstanceAccess(object, name, scope, property, 'get', !reportedStatic);
  const decl = property?.isStatic ? undefined : property;
  const key = decl?.key ?? name;
  if (decl && !canAccessProp(decl, scope)) {
    const overloaded = overloadedPropertyReference(object, name);
    if (overloaded) return overloaded;
    throwError('Error', `Cannot access ${decl.visibility} property ${object.cls.name}::$${name}`);
  }
  const getter = decl?.hooks?.get;
  if (mode === 'foreach') {
    if (decl?.isReadonly)
      throwError('Error', `Cannot acquire reference to readonly property ${decl.cls.name}::$${name}`);
    if (decl?.hooks && !(getter?.kind === 'user' && getter.decl.byRefReturn))
      throwError('Error', `Cannot create reference to property ${object.cls.name}::$${name}`);
  }
  if (decl && getter && !object.guards?.has(`hook:${name}`)) return hookedPropertyReference(object, decl, scope);
  if (mode === 'alias') {
    const indirect = checkIndirectModification(object, name, scope);
    if (indirect) return Ref.temporary(indirect);
  }
  let slot = object.props.get(key);
  if (slot instanceof Ref) return slot;
  if (object.unsetProperties?.has(key)) {
    const overloaded = overloadedPropertyReference(object, name, decl);
    if (overloaded) return overloaded;
  }
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
  if (decl?.type) ref.typedBy = [{ decl, object }];
  object.props.set(key, ref);
  return ref;
}

export function requireVirtualPropertyHook(object: PhpObject, decl: PropDecl, hook: 'get' | 'set'): void {
  if (decl.isVirtual && decl.hooks && !decl.hooks[hook]) {
    throwError('Error', `Property ${object.cls.name}::$${decl.name} is ${hook === 'get' ? 'write' : 'read'}-only`);
  }
}

function isBackingAccess(object: PhpObject, decl: PropDecl, operation: 'read' | 'write'): boolean {
  if (!decl.hooks || !object.guards?.has(`hook:${decl.name}`)) return false;
  if (decl.isVirtual)
    throwError(
      'Error',
      `Must not ${operation} ${operation === 'read' ? 'from' : 'to'} virtual property ${decl.cls.name}::$${decl.name}`
    );
  return true;
}

export function hookedPropertyReference(object: PhpObject, decl: PropDecl, scope: PhpClass | undefined): Ref {
  const runtime = rt();
  runtime.lastReturnRef = undefined;
  try {
    const value = readProp(object, decl.name, scope, 'quiet');
    if (runtime.lastReturnRef) return runtime.lastReturnRef;
    if (value instanceof PhpObject && !value.isResource) return Ref.temporary(value);
    throwError('Error', `Indirect modification of ${object.cls.name}::$${decl.name} is not allowed`);
  } finally {
    runtime.lastReturnRef = undefined;
  }
}

function overloadedPropertyReference(object: PhpObject, name: string, decl?: PropDecl): Ref | undefined {
  const magic = object.cls.findMethod('__get');
  if (!magic || object.guards?.has(`get:${name}`)) return;
  const runtime = rt();
  runtime.lastReturnRef = undefined;
  try {
    const value = guarded(object, `get:${name}`, () => callMagic(object, magic, [name]));
    const returned = runtime.lastReturnRef;
    if (!returned && !(value instanceof PhpObject))
      notice(`Indirect modification of overloaded property ${object.cls.name}::$${name} has no effect`);
    const checked = checkUnsetGetterValue(value, decl, returned);
    return returned ?? Ref.temporary(checked);
  } finally {
    runtime.lastReturnRef = undefined;
  }
}

// code-gauge-allow functionCognitiveComplexity 26 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
// code-gauge-allow functionNcss 41 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
export function bindPropertyReference(object: PhpObject, name: string, ref: Ref, scope: PhpClass | undefined): void {
  if (object.isResource) throwError('Error', `Attempt to modify property "${name}" on resource`);
  const property = lookupProp(object.cls, name, scope);
  checkStaticInstanceAccess(object, name, scope, property, 'get');
  const decl = property?.isStatic ? undefined : property;
  const accessible = decl && canAccessProp(decl, scope);
  const magic = !accessible && object.cls.findMethod('__get');
  const hooked = decl?.hooks?.get && accessible && !isBackingAccess(object, decl, 'write');
  if (magic || hooked) {
    const runtime = rt();
    runtime.lastReturnRef = undefined;
    try {
      const value = readProp(object, name, scope, 'quiet');
      if (magic && !(value instanceof PhpObject) && !runtime.lastReturnRef)
        notice(`Indirect modification of overloaded property ${object.cls.name}::$${name} has no effect`);
    } finally {
      runtime.lastReturnRef = undefined;
    }
    throwError('Error', 'Cannot assign by reference to overloaded object');
  }
  if (decl) {
    if (checkIndirectModification(object, name, scope))
      throwError('Error', 'Cannot assign by reference to overloaded object');
    if (decl.type) attachPropertyReference(ref, decl, object);
  } else if (!object.props.has(name)) {
    ref.isRef = true;
    try {
      createDynamicProp(object, name, ref);
    } finally {
      if (object.props.get(name) === ref) ref.rc++;
    }
    return;
  }
  const key = decl?.key ?? name;
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
        `Reference with value of type ${valueName(ref.v)} held by property ${source.cls.name}::$${source.name} of type ${describePropertyType(source)} is not compatible with property ${decl.cls.name}::$${decl.name} of type ${describePropertyType(decl)}`
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
        `Cannot assign ${valueName(value)} to reference held by property ${decl.cls.name}::$${decl.name} of type ${describePropertyType(decl)}`
      );
    }
  }
  return coerced;
}

// code-gauge-allow functionCognitiveComplexity 29 -- Follows PHP's class linking and property access rules in their order of checks.
// code-gauge-allow functionNcss 38 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
export function unsetProp(object: PhpObject, name: string, scope: PhpClass | undefined): void {
  if (object.isResource) return;
  const decl = lookupProp(object.cls, name, scope);
  checkStaticInstanceAccess(object, name, scope, decl, 'unset');
  if (decl && !decl.isStatic) {
    if (!canAccessProp(decl, scope)) {
      const magic = object.cls.findMethod('__unset');
      if (magic && !object.guards?.has(`unset:${name}`)) {
        guarded(object, `unset:${name}`, () => callMagic(object, magic, [name]));
        return;
      }
      throwError('Error', `Cannot access ${decl.visibility} property ${object.cls.name}::$${name}`);
    }
    if (decl.hooks) throwError('Error', `Cannot unset hooked property ${decl.cls.name}::$${name}`);
    if (object.unsetProperties?.has(decl.key)) {
      const magic = object.cls.findMethod('__unset');
      if (magic && !object.guards?.has(`unset:${name}`)) {
        guarded(object, `unset:${name}`, () => callMagic(object, magic, [name]));
        return;
      }
    }
    const slot = object.props.get(decl.key);
    if (decl.isReadonly && slot !== UNINIT && slot !== undefined)
      throwError('Error', `Cannot unset readonly property ${decl.cls.name}::$${name}`);
    if (!canWriteProp(decl, scope))
      throwError(
        'Error',
        `Cannot unset ${setterAccessLabel(decl)} property ${decl.cls.name}::$${name} from ${scopeText(scope)}`
      );
    if (slot instanceof Ref) slot.rc--;
    object.props.set(decl.key, UNINIT);
    (object.unsetProperties ??= new Set()).add(decl.key);
    return;
  }
  if (object.props.has(name)) {
    const slot = object.props.get(name);
    if (slot instanceof Ref) slot.rc--;
    object.props.delete(name);
    return;
  }
  const magic = object.cls.findMethod('__unset');
  if (magic && !object.guards?.has(`unset:${name}`))
    guarded(object, `unset:${name}`, () => callMagic(object, magic, [name]));
}

// code-gauge-allow functionCognitiveComplexity 27 -- Follows PHP's class linking and property access rules in their order of checks.
export function issetProp(object: PhpObject, name: string, scope: PhpClass | undefined, internal = false): boolean {
  if (object.isResource) return false;
  const decl = lookupProp(object.cls, name, scope);
  if (decl && !decl.isStatic && canAccessProp(decl, scope)) {
    requireVirtualPropertyHook(object, decl, 'get');
    if (decl.hooks?.get) return readProp(object, name, scope, internal ? 'native' : 'quiet') !== null;
    const slot = object.props.get(decl.key);
    if (slot === UNINIT && !object.unsetProperties?.has(decl.key)) return false;
    if (slot !== undefined && slot !== UNINIT) return (slot instanceof Ref ? slot.v : slot) !== null;
  } else if (!decl || decl.isStatic) {
    const slot = object.props.get(name);
    if (slot !== undefined && slot !== UNINIT) return (slot instanceof Ref ? slot.v : slot) !== null;
  }
  const magic = object.cls.findMethod('__isset');
  if (magic && !object.guards?.has(`isset:${name}`)) {
    return toBool(guarded(object, `isset:${name}`, () => callMagic(object, magic, [name], internal)));
  }
  return false;
}

export function objectPropertyKeys(object: PhpObject): string[] {
  return [...new Set([...object.cls.props.map((decl) => decl.key), ...object.props.keys()])];
}

export function snapshotDynamicProperties(object: PhpObject): PhpArray {
  const snapshot = new PhpArray();
  for (const [key, slot] of object.props) {
    rt().spend();
    if (!declForKey(object.cls, key) && slot !== UNINIT) snapshot.setSlot(key, copyValueSlot(slot));
  }
  return snapshot;
}

export function* visiblePropertyKeys(
  object: PhpObject,
  scope: PhpClass | undefined,
  includeVirtual = false
): Generator<string> {
  for (const key of includeVirtual ? livePropertyKeys(object) : object.props.keys()) {
    rt().spend();
    const slot = object.props.get(key);
    const decl = declForKey(object.cls, key);
    if ((!includeVirtual || !decl?.hooks?.get) && (slot === UNINIT || slot === undefined)) continue;
    if (decl && !isVisibleProperty(object, decl, scope)) continue;
    yield key;
  }
}

function* livePropertyKeys(object: PhpObject): Generator<string> {
  for (const decl of object.cls.props) yield decl.key;
  for (const key of object.props.keys()) {
    if (!declForKey(object.cls, key)) yield key;
  }
}

export function visibleProps(object: PhpObject, scope: PhpClass | undefined): [string, Value][] {
  return Array.from(visiblePropertyKeys(object, scope), (key) => {
    const slot = object.props.get(key) as Value | Ref;
    return [propNameOf(key), slot instanceof Ref ? slot.v : slot];
  });
}

export function isVisibleProperty(object: PhpObject, decl: PropDecl, scope: PhpClass | undefined): boolean {
  return !decl.isStatic && canAccessProp(decl, scope) && lookupProp(object.cls, decl.name, scope) === decl;
}

export function nativePropertySlot(
  object: PhpObject,
  key: string,
  decl: PropDecl | undefined
): Value | Ref | undefined {
  if (decl?.hooks?.get) return readProp(object, decl.name, decl.cls, 'native');
  const slot = object.props.get(key);
  if (slot !== undefined && slot !== UNINIT) return slot;
  if (decl?.hooks && !decl.isVirtual && !object.unsetProperties?.has(decl.key)) return null;
  return undefined;
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

export function staticPropRef(cls: PhpClass, name: string, scope: PhpClass | undefined, reportTraitAccess = true): Ref {
  const found = cls.findStatic(name);
  if (!found) throwError('Error', `Access to undeclared static property ${cls.name}::$${name}`);
  if (!canAccessProp(found.decl, scope)) {
    throwError('Error', `Cannot access ${found.decl.visibility} property ${cls.name}::$${name}`);
  }
  if (reportTraitAccess && cls.kind === 'trait')
    deprecated(
      `Accessing static trait property ${cls.name}::$${name} is deprecated, it should only be accessed on a class using the trait`
    );
  initializeClassDefaults(cls);
  const ref = resolveStatic(found.ref);
  if (found.decl.type) ref.addTypeOwner(found.decl);
  return ref;
}

const initializedClasses = new WeakSet<PhpClass>();

function initializeClassDefaults(cls: PhpClass): void {
  const pending: PhpClass[] = [];
  for (let current: PhpClass | undefined = cls; current && !initializedClasses.has(current); current = current.parent) {
    pending.push(current);
  }
  while (pending.length > 0) {
    const current = pending.pop()!;
    initializeClassConstants(current);
    for (const prop of current.props) {
      if (prop.cls === current) prop.defaultValue?.();
    }
    for (const { ref } of current.staticProps.values()) resolveStatic(ref);
    initializedClasses.add(current);
  }
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
