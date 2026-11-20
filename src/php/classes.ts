// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { arrayObjectProperty } from './arrayObjectProperties';
import type { ClassDecl, Expr, FunctionDecl, MethodDeclAst, PropertyDeclAst, TraitRule } from './ast';
import { canBindClass, declaresStringConversion } from './astAnalysis';
import builtinNames from './builtinNames.json';
import { consumeInvokedResult, discardInvokedResult } from './callables';
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
import { formatFloat, normalizeKeyString, toBool, valueName } from './conversions';
import {
  deprecated,
  E_COMPILE_WARNING,
  emitError,
  notice,
  throwError,
  type UpdateWarning,
  warn,
  withOperandWarnings,
} from './errors';
import { strictEquals } from './operators';
import { share } from './places';
import { FatalError, type PhpThrow, rt, SCRIPT_PATH } from './runtime';
import tentativeReturnMethods from './tentativeReturnMethods.json';
import { coerce, describePropertyType, describeType, NO_MATCH, parameterType } from './types';
import { UnsupportedFeatureError } from './unsupported';
import { unsupportedClasses } from './unsupportedCatalog';
import {
  type Callable,
  copyValueSlot,
  dropped,
  isSetSlot,
  type Method,
  type Param,
  PhpArray,
  PhpClass,
  PhpObject,
  type PropDecl,
  type PropertyDefault,
  Ref,
  setReferenceTypeCheck,
  type Slot,
  type TypeDecl,
  UNDEFINED_RESULT,
  UNINIT,
  type UserFunction,
  type Value,
  type Visibility,
  visibilityRank,
} from './values';
import { isSubtype, sameDeclarationType, variance } from './variance';

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
  if (
    cls.kind !== 'trait' &&
    declaresStringConversion(decl) &&
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
  linkTraitStringable(cls);
  linkInterfaceConstants(cls, row);
  checkInheritance(cls, row);
  if (!decl.isAnonymous) runtime.classes.set(key, cls);
  runtime.userClasses.push(cls);
  return cls;
}

function linkTraitStringable(cls: PhpClass): void {
  if (cls.kind === 'trait' || !cls.methods.has('__tostring')) return;
  const stringable = findClass('Stringable')!;
  if (!cls.interfaces.includes(stringable)) {
    cls.ownInterfaces.push(stringable);
    cls.interfaces.push(stringable);
  }
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
  for (const [decl, initial] of parent.propertyDefaults)
    cls.propertyDefaults.set(decl, initial.value === undefined ? { expression: initial.expression } : initial);
  for (const [name, decl] of parent.propByName) cls.propByName.set(name, decl);
  for (const [name, constant] of parent.consts) {
    if (constant.visibility !== 'private') cls.consts.set(name, constant);
  }
  cls.createInternal = parent.createInternal;
  cls.compare = parent.compare;
  cls.isCloneable = parent.isCloneable;
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
  if (!propertyTypeCompatible(inherited, ast, cls, declarationScope)) {
    propertyTypeError(inherited, cls, ast.name, cls.declaredRow);
  }
}

// code-gauge-allow functionCognitiveComplexity 27 -- Populates property slots, defaults and hooks together.
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
  if (ast.defaultExpr) registerPropertyDefault(decl, ast.defaultExpr);
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
  if (index !== -1) {
    cls.propertyDefaults.delete(cls.props[index]);
    cls.props[index] = decl;
  } else cls.props.push(decl);
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

function registerPropertyDefault(decl: PropDecl, expression: Expr): void {
  const initial: PropertyDefault = { expression };
  if (decl.isStatic) decl.defaultValue = () => resolvePropertyDefault(decl, initial);
  else decl.cls.propertyDefaults.set(decl, initial);
}

function initialPropertyValue(cls: PhpClass, decl: PropDecl): Value | typeof UNINIT {
  const initial = cls.propertyDefaults.get(decl);
  if (initial) return resolvePropertyDefault(decl, initial);
  if (decl.defaultValue) return decl.defaultValue();
  return decl.type ? UNINIT : null;
}

function resolvePropertyDefault(decl: PropDecl, initial: PropertyDefault): Value {
  if (initial.value === undefined) {
    const value = evaluatePropertyDefault(decl, initial.expression);
    if (value instanceof PhpArray) value.persistentHolder = true;
    if (!decl.isStatic && (value instanceof PhpArray || value instanceof PhpObject)) rt().declarationRoots.add(value);
    initial.value = value;
  }
  return share(initial.value);
}

function evaluatePropertyDefault(decl: PropDecl, expression: Expr): Value {
  const runtime = rt();
  const row = runtime.row;
  const value = evaluateInClass(expression, decl.cls);
  runtime.row = row;
  if (!decl.type) return value;
  const coerced = coerce(value, decl.type, { strict: true, internal: false, scope: decl.cls });
  if (coerced === NO_MATCH)
    throwError(
      'TypeError',
      `Cannot assign ${valueName(value)} to property ${decl.cls.name}::$${decl.name} of type ${describePropertyType(decl)}`
    );
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

function applyTraits(cls: PhpClass, decl: ClassDecl): void {
  if (cls.traits.length === 0) return;
  const rules = decl.traits.flatMap((use) => use.rules);
  const excluded = traitPrecedence(cls, rules, decl.row);
  const aliases = new Map<Method, Extract<TraitRule, { k: 'as' }>[]>();
  for (const rule of rules) {
    if (rule.k !== 'as') continue;
    const source = traitAliasSource(cls, rule, decl.row);
    const method = source.methods.get(lower(rule.method))!;
    const adaptations = aliases.get(method);
    if (adaptations) adaptations.push(rule);
    else aliases.set(method, [rule]);
  }
  const methods = cls.traits.flatMap((trait) => [...trait.methods.values()]);
  const imported = new Map<string, Method>();
  for (const isAbstract of [false, true])
    for (const method of methods)
      if (method.isAbstract === isAbstract)
        importTraitMethod(cls, method, aliases.get(method) ?? [], excluded, imported);
  const propertyOrigins = new Map<string, string>();
  const constantOrigins = new Map<string, string>();
  for (const trait of cls.traits) {
    applyTraitProperties(cls, trait, propertyOrigins, decl.row);
    applyTraitConstants(cls, trait, constantOrigins, decl.row);
  }
}

function importTraitMethod(
  cls: PhpClass,
  original: Method,
  aliases: Extract<TraitRule, { k: 'as' }>[],
  excluded: Set<string>,
  imported: Map<string, Method>
): void {
  let method = original;
  for (const rule of aliases) {
    const adapted = {
      ...original,
      name: rule.alias ?? original.name,
      lname: rule.alias ? lower(rule.alias) : original.lname,
      visibility: rule.visibility ?? original.visibility,
      isFinal: original.isFinal || rule.isFinal === true,
    };
    if (rule.alias) addTraitMethod(cls, adapted, original, imported);
    else method = adapted;
  }
  if (original.isAbstract || !excluded.has(`${lower(original.cls.name)}::${original.lname}`))
    addTraitMethod(cls, method, original, imported);
}

function addTraitMethod(cls: PhpClass, method: Method, original: Method, imported: Map<string, Method>): void {
  if (!original.isFinal && method.isFinal && method.visibility === 'private' && method.lname !== '__construct')
    emitError(
      E_COMPILE_WARNING,
      'Private methods cannot be final as they are never overridden by other classes',
      cls.declaredRow
    );
  const existing = cls.methods.get(method.lname);
  const previous = imported.get(method.lname);
  if (previous && existing?.visibility === method.visibility && sameTraitBody(previous.fn, original.fn)) return;
  if (method.isAbstract) {
    const implementation = existing ?? cls.parent?.findMethod(method.lname);
    if (implementation) {
      checkTraitContract(cls, implementation, method);
      return;
    }
  }
  if (existing && !previous) return;
  if (existing && previous && !existing.isAbstract)
    throw new FatalError(
      `Trait method ${original.cls.name}::${original.name} has not been applied as ${cls.name}::${method.name}, because of collision with ${previous.cls.name}::${existing.name}`,
      cls.declaredRow
    );
  imported.set(method.lname, original);
  cls.methods.set(method.lname, { ...method, cls, scope: cls, fn: copyFunction(method.fn) });
}

function sameTraitBody(left: Callable, right: Callable): boolean {
  return left === right || (left.kind === 'user' && right.kind === 'user' && left.decl === right.decl);
}

function checkTraitContract(cls: PhpClass, method: Method, contract: Method): void {
  const row = method.fn.kind === 'user' ? method.fn.decl.row : 0;
  checkFinalMethod(method, contract, row);
  checkMethodStaticness(method, contract, row);
  const compatibility = signatureCompatible(method, { ...contract, cls });
  if (compatibility !== true) throw incompatibleMethod(method, signatureText(contract, cls), compatibility, row);
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
  const left = initialPropertyValue(cls, existing);
  const right = property.defaultExpr ? evaluateInClass(property.defaultExpr, cls) : property.type ? UNINIT : null;
  return left === UNINIT || right === UNINIT ? left === right : strictEquals(left, right);
}

function copyFunction(fn: Callable): Callable {
  if (fn.kind === 'native') return fn;
  return { ...fn, statics: new Map() };
}

const interfaceMethods = new WeakMap<PhpClass, Map<string, Method>>();

function checkInheritance(cls: PhpClass, row: number): void {
  const ancestors: PhpClass[] = [];
  for (let parent = cls.parent; parent; parent = parent.parent) ancestors.push(parent);
  const inherited = new Map<string, Method>();
  for (const parent of ancestors.toReversed()) {
    for (const method of parent.methods.values()) inherited.set(method.lname, method);
    for (const [name, method] of interfaceMethods.get(parent) ?? []) inherited.set(name, method);
  }
  const contracts = bindInterfaceMethods(cls, inherited, checkParentMethods(cls, inherited));
  const hooks = missingPropertyHooks(cls, ancestors, row);
  if (cls.kind !== 'class' || cls.isAbstract) return;
  const missing = unimplementedMethods(cls, inherited, contracts);
  const allNames = [...missing.map((method) => `${method.cls.name}::${method.name}`), ...hooks];
  if (allNames.length === 0) return;
  const names = allNames.slice(0, 3);
  const count = allNames.length;
  const methods = count === 1 ? 'method' : 'methods';
  const requirement = cls.isAnonymous
    ? `must implement ${count} abstract ${methods}`
    : `contains ${count} abstract ${methods} and must therefore be declared abstract or implement the remaining ${methods}`;
  throw new FatalError(`Class ${cls.name} ${requirement} (${names.join(', ')}${count > 3 ? ', ...' : ''})`, row);
}

function checkParentMethods(cls: PhpClass, inherited: Map<string, Method>): Set<string> {
  const checked = new Set<string>();
  for (const [name, parentMethod] of inherited) {
    const method = cls.methods.get(name);
    if (!method) continue;
    if (parentMethod.visibility === 'private') {
      if (name === '__construct')
        checkFinalMethod(method, parentMethod, method.fn.kind === 'user' ? method.fn.decl.row : cls.declaredRow);
      continue;
    }
    checkOverride(cls, method, parentMethod);
    checked.add(name);
  }
  return checked;
}

function unimplementedMethods(cls: PhpClass, inherited: Map<string, Method>, contracts: Map<string, Method>): Method[] {
  const missing: Method[] = [];
  const seen = new Set<string>();
  for (let current: PhpClass | undefined = cls; current; current = current.parent) {
    for (const method of current.methods.values()) {
      if (seen.has(method.lname)) continue;
      seen.add(method.lname);
      if (method.isAbstract) missing.push(method);
    }
  }
  for (const [name, method] of inherited) if (!seen.has(name) && method.isAbstract) missing.push(method);
  return [...missing, ...contracts.values()];
}

function bindInterfaceMethods(
  cls: PhpClass,
  inherited: Map<string, Method>,
  checked: Set<string>
): Map<string, Method> {
  const contracts = new Map<string, Method>();
  for (const iface of cls.ownInterfaces) {
    if (cls.parent?.interfaces.includes(iface)) continue;
    for (const [name, contract] of effectiveInterfaceMethods(iface)) {
      const method = cls.methods.get(name) ?? inherited.get(name) ?? contracts.get(name);
      if (!method) contracts.set(name, contract);
      else if (method !== contract) {
        checkOverride(cls, method, contract, !checked.has(name));
        checked.add(name);
      }
    }
  }
  interfaceMethods.set(cls, cls.kind === 'interface' ? new Map([...cls.methods, ...contracts]) : contracts);
  return contracts;
}

function effectiveInterfaceMethods(iface: PhpClass): Map<string, Method> {
  const contracts = interfaceMethods.get(iface);
  if (contracts) return contracts;
  const methods = new Map(iface.methods);
  for (const parent of iface.ownInterfaces)
    for (const [name, method] of effectiveInterfaceMethods(parent)) if (!methods.has(name)) methods.set(name, method);
  interfaceMethods.set(iface, methods);
  return methods;
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
  const row = method.fn.kind === 'user' ? method.fn.decl.row : 0;
  if (method.cls === cls && !parent.cls.decl?.isAnonymous) checkFinalMethod(method, parent, row);
  checkMethodStaticness(method, parent, row);
  if (visibilityRank(method.visibility) < visibilityRank(parent.visibility)) {
    throw new FatalError(
      `Access level to ${method.cls.name}::${method.name}() must be ${parent.visibility}${parent.visibility === 'protected' ? ' (as in class ' + parent.cls.name + ') or weaker' : ` (as in class ${parent.cls.name})`}`,
      row
    );
  }
  if (lower(method.name) === '__construct' && !parent.isAbstract && parent.cls.kind !== 'interface') return;
  const tentative =
    !parent.cls.isUser && tentativeReturnMethods.includes(lower(parent.scope.name + '::' + parent.name));
  const compatibility = signatureCompatible(method, parent, tentative);
  if (compatibility !== true) throw incompatibleMethod(method, signatureText(parent), compatibility, row);
  const expected = tentative ? returnTypeOf(parent.fn) : undefined;
  if (expected) {
    const actual = returnTypeOf(method.fn);
    const result = actual ? variance(actual, method.cls, expected, parent.cls) : false;
    if (typeof result === 'string') throw incompatibleMethod(method, signatureText(parent), result, row);
    if (!result && reportTentative) {
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

/** The fatal error for an override PHP rejects, or cannot check because `compatibility` names a missing class. */
function incompatibleMethod(
  method: Method,
  parentText: string,
  compatibility: false | string,
  row: number
): FatalError {
  return new FatalError(
    compatibility === false
      ? `Declaration of ${signatureText(method)} must be compatible with ${parentText}`
      : `Could not check compatibility between ${signatureText(method)} and ${parentText}, because class ${compatibility} is not available`,
    row
  );
}

function checkFinalMethod(method: Method, parent: Method, row: number): void {
  if (parent.isFinal) throw new FatalError(`Cannot override final method ${parent.cls.name}::${method.name}()`, row);
}

function checkMethodStaticness(method: Method, parent: Method, row: number): void {
  if (parent.isStatic !== method.isStatic) {
    throw new FatalError(
      parent.isStatic
        ? `Cannot make static method ${parent.cls.name}::${parent.name}() non static in class ${method.cls.name}`
        : `Cannot make non static method ${parent.cls.name}::${parent.name}() static in class ${method.cls.name}`,
      row
    );
  }
}

/**
 * Whether a method may override another as PHP's inheritance check allows: it accepts every call the parent accepts
 * (parameters as many, as optional, and as wide in type) and returns only what the parent may return. A string result
 * is the missing class that leaves the check unresolved.
 */
function signatureCompatible(child: Method, parent: Method, skipReturn = false): boolean | string {
  if (
    parent.fn.kind === 'user' &&
    parent.fn.decl.byRefReturn &&
    (child.fn.kind !== 'user' || !child.fn.decl.byRefReturn)
  )
    return false;
  const params = parametersCompatible(child, parent);
  const parentReturn = skipReturn ? undefined : returnTypeOf(parent.fn);
  if (params === false || !parentReturn) return params;
  const childReturn = returnTypeOf(child.fn);
  const result = childReturn ? variance(childReturn, child.cls, parentReturn, parent.cls) : false;
  if (result === true) return params;
  return result && (typeof params === 'string' ? params : result);
}

// code-gauge-allow functionCognitiveComplexity 20 -- Checks parameters in PHP's order, keeping the first unresolved class it reports.
function parametersCompatible(child: Method, parent: Method): boolean | string {
  const childParams = child.fn.params;
  const parentParams = parent.fn.params;
  const childRequired = childParams.filter((param) => !param.optional && !param.variadic).length;
  if (childRequired > parentParams.filter((param) => !param.variadic).length) return false;
  let unresolved: string | undefined;
  for (const [index, param] of parentParams.entries()) {
    const own = childParams[index] ?? (childParams.at(-1)?.variadic ? childParams.at(-1) : undefined);
    if (!own || (param.variadic && !childParams.at(-1)?.variadic)) return false;
    for (const candidate of param.variadic ? [own, ...childParams.slice(index)] : [own]) {
      const result = paramCompatible(candidate, child.cls, param, parent.cls);
      if (result === false) return false;
      if (typeof result === 'string') unresolved ??= result;
    }
  }
  return unresolved ?? true;
}

function paramCompatible(own: Param, ownClass: PhpClass, param: Param, parentClass: PhpClass): boolean | string {
  if (param.byRef !== own.byRef) return false;
  if (param.optional && !own.optional && !own.variadic) return false;
  const ownType = parameterType(own);
  if (!ownType) return true;
  const paramType = parameterType(param);
  if (!paramType) return ownType.k === 'named' && ownType.name === 'mixed';
  return variance(paramType, parentClass, ownType, ownClass);
}

function returnTypeOf(fn: Callable): TypeDecl | undefined {
  return fn.kind === 'user' ? fn.decl.returnType : fn.returnType;
}

// code-gauge-allow functionCognitiveComplexity 19 -- Follows PHP's class linking and property access rules in their order of checks.
function signatureText(method: Method, typeScope = method.scope): string {
  const fn = method.fn;
  const params = fn.params
    .map((param) => {
      let text = '';
      const type = parameterType(param);
      if (type) text += `${describeType(type, typeScope)} `;
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
  return `${fn.kind === 'user' && fn.decl.byRefReturn ? '& ' : ''}${method.scope.name}::${method.name}(${params})${returnType ? `: ${describeType(returnType, typeScope)}` : ''}`;
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
    object.props.set(decl.key, initialPropertyValue(object.cls, decl));
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

function magicIsset(object: PhpObject, method: Method, name: string, internal = false): boolean {
  return consumeInvokedResult(() => callMagic(object, method, [name], internal), toBool);
}

function discardMagicResult(object: PhpObject, method: Method, args: [name: string, ...values: Value[]]): void {
  guarded(object, `${method.lname.slice(2)}:${args[0]}`, () =>
    discardInvokedResult(() => callMagic(object, method, args))
  );
}

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

// code-gauge-allow functionNcss 50 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
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
  const storage = arrayObjectProperty(object, name, scope, decl);
  if (storage) return storage.read(mode);
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
      return mode === 'native' ? asInternal(() => invoke(target, [], undefined)) : invoke(target, [], rt().row);
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

// code-gauge-allow functionCognitiveComplexity 16 -- Keeps the property probe guards tied to their result boundaries.
function readOverloadedProp(
  object: PhpObject,
  name: string,
  mode: Parameters<typeof readProp>[3],
  unset?: PropDecl
): Value | undefined {
  const isset = mode === 'coalesce' || mode === 'empty' ? object.cls.findMethod('__isset') : undefined;
  if (isset && !object.guards?.has(`isset:${name}`)) {
    const key = `isset:${name}`;
    if (mode === 'empty')
      return guarded(object, key, () => {
        if (!magicIsset(object, isset, name)) return false;
        return consumeInvokedResult(
          () => readOverloadedProp(object, name, 'quiet'),
          (value) => value !== undefined && toBool(value)
        );
      });
    if (!consumeInvokedResult(() => guarded(object, key, () => callMagic(object, isset, [name])), toBool)) return null;
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
  const storage = arrayObjectProperty(object, name, scope, decl);
  if (storage) return storage.set(value);
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
      invoke(
        {
          fn: decl.hooks?.set as Callable,
          thisObj: object,
          scope: decl.hooks?.setScope ?? decl.cls,
          staticClass: object.cls,
        },
        [{ v: value }],
        rt().row
      );
      return value;
    }
    requireVirtualPropertyHook(object, decl, 'set');
    const slot = object.props.get(decl.key);
    const referenceUpdate = options.operation === 'assignOp' && slot instanceof Ref && slot.isRef;
    const coerced = decl.type && !referenceUpdate ? coerceProperty(decl, value, object) : value;
    if (slot instanceof Ref) return slot.assign(coerced);
    object.props.set(decl.key, share(coerced));
    dropped(slot);
    return coerced;
  }
  const slot = object.props.get(name);
  if (slot !== undefined) {
    if (slot instanceof Ref) return slot.assign(value);
    object.props.set(name, share(value));
    dropped(slot);
    return value;
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
  discardMagicResult(object, magic, [name, value]);
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
  const runtime = rt();
  const coerced = coerce(value, type, {
    strict: runtime.strictTypes,
    internal: false,
    scope: decl.cls,
    staticClass: object?.cls,
    pendingPropertyDiagnostic: runtime.pendingPropertyCoercion !== undefined,
  });
  if (coerced === NO_MATCH) {
    const pending = runtime.pendingAssignmentWarning;
    if (pending && runtime.pendingPropertyCoercion !== 'reference-update') throw pending;
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
// code-gauge-allow functionNcss 49 -- Follows PHP's class linking and property access rules in their order of checks.
export function propRef(
  object: PhpObject,
  name: string,
  scope: PhpClass | undefined,
  mode: 'alias' | 'foreach' = 'alias',
  reportedStatic = false
): Ref {
  if (object.isResource) throwError('Error', `Attempt to modify property "${name}" on resource`);
  const property = lookupProp(object.cls, name, scope);
  const storage = arrayObjectProperty(object, name, scope, property);
  if (storage) return storage.ref();
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
  if (decl && getter && !inPropertyHook(object, decl)) return hookedPropertyReference(object, decl, scope);
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

export function inPropertyHook(object: PhpObject, decl: PropDecl): boolean {
  const frame = rt().frame;
  return (
    frame.thisObj === object && decl.hooks !== undefined && (frame.fn === decl.hooks.get || frame.fn === decl.hooks.set)
  );
}

function isBackingAccess(object: PhpObject, decl: PropDecl, operation: 'read' | 'write'): boolean {
  if (!inPropertyHook(object, decl)) return false;
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
// code-gauge-allow functionNcss 46 -- Shares property lookup and validation across reference binding and value fallback.
export function bindPropertyReference(
  object: PhpObject,
  name: string,
  ref: Ref,
  scope: PhpClass | undefined,
  valueFallback = false
): void {
  if (object.isResource) throwError('Error', `Attempt to modify property "${name}" on resource`);
  const property = lookupProp(object.cls, name, scope);
  const storage = arrayObjectProperty(object, name, scope, property);
  if (storage) return storage.bind(ref, valueFallback);
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
  if (decl && checkIndirectModification(object, name, scope))
    throwError('Error', 'Cannot assign by reference to overloaded object');
  if (valueFallback) notice('Only variables should be assigned by reference');
  const key = decl?.key ?? name;
  const old = object.props.get(key);
  if (valueFallback) return writePropertyFallback(object, key, old, ref, decl);
  if (decl?.type) attachPropertyReference(ref, decl, object);
  if (!decl && old === undefined) {
    ref.isRef = true;
    try {
      createDynamicProp(object, name, ref);
    } finally {
      if (object.props.get(name) === ref) ref.rc++;
    }
    return;
  }
  if (old === ref) return dropped(old);
  if (old instanceof Ref) old.rc--;
  ref.isRef = true;
  ref.rc++;
  object.props.set(key, ref);
  dropped(old);
}

function writePropertyFallback(
  object: PhpObject,
  key: string,
  old: Slot | undefined,
  source: Ref,
  decl?: PropDecl
): void {
  if (old instanceof Ref) {
    source.v = old.assign(share(source.v));
    return;
  }
  const value = decl?.type ? coerceProperty(decl, source.v, object) : source.v;
  if (!decl && old === undefined) createDynamicProp(object, key, share(value));
  else {
    object.props.set(key, share(value));
    dropped(old);
  }
  source.v = value;
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

// code-gauge-allow functionCognitiveComplexity 30 -- Follows PHP's class linking and property access rules in their order of checks.
// code-gauge-allow functionNcss 41 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
export function unsetProp(object: PhpObject, name: string, scope: PhpClass | undefined): void {
  if (object.isResource) return;
  const decl = lookupProp(object.cls, name, scope);
  const storage = arrayObjectProperty(object, name, scope, decl);
  if (storage) return storage.unset();
  checkStaticInstanceAccess(object, name, scope, decl, 'unset');
  if (decl && !decl.isStatic) {
    if (!canAccessProp(decl, scope)) {
      const magic = object.cls.findMethod('__unset');
      if (magic && !object.guards?.has(`unset:${name}`)) {
        discardMagicResult(object, magic, [name]);
        return;
      }
      throwError('Error', `Cannot access ${decl.visibility} property ${object.cls.name}::$${name}`);
    }
    if (decl.hooks) throwError('Error', `Cannot unset hooked property ${decl.cls.name}::$${name}`);
    if (object.unsetProperties?.has(decl.key)) {
      const magic = object.cls.findMethod('__unset');
      if (magic && !object.guards?.has(`unset:${name}`)) {
        discardMagicResult(object, magic, [name]);
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
  if (magic && !object.guards?.has(`unset:${name}`)) discardMagicResult(object, magic, [name]);
}

// code-gauge-allow functionCognitiveComplexity 27 -- Follows PHP's class linking and property access rules in their order of checks.
export function issetProp(object: PhpObject, name: string, scope: PhpClass | undefined, internal = false): boolean {
  if (object.isResource) return false;
  const decl = lookupProp(object.cls, name, scope);
  const storage = arrayObjectProperty(object, name, scope, decl);
  if (storage) return storage.has('isset');
  if (decl && !decl.isStatic && canAccessProp(decl, scope)) {
    requireVirtualPropertyHook(object, decl, 'get');
    if (decl.hooks?.get) return readProp(object, name, scope, internal ? 'native' : 'quiet') !== null;
    const slot = object.props.get(decl.key);
    if (slot === UNINIT && !object.unsetProperties?.has(decl.key)) return false;
    if (slot !== undefined && slot !== UNINIT) return isSetSlot(slot);
  } else if (!decl || decl.isStatic) {
    const slot = object.props.get(name);
    if (slot !== undefined && slot !== UNINIT) return isSetSlot(slot);
  }
  const magic = object.cls.findMethod('__isset');
  if (magic && !object.guards?.has(`isset:${name}`)) {
    return guarded(object, `isset:${name}`, () => magicIsset(object, magic, name, internal));
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
    if ((!includeVirtual || !decl?.hooks?.get) && (slot === UNINIT || slot === undefined || slot === UNDEFINED_RESULT))
      continue;
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

export function staticPropRef(
  cls: PhpClass,
  name: string,
  scope: PhpClass | undefined,
  reportTraitAccess = true,
  warning?: UpdateWarning
): Ref {
  const found = cls.findStatic(name);
  if (!found) {
    const instance = cls.propByName.get(name);
    if (instance && !canAccessProp(instance, scope))
      throwError('Error', `Cannot access ${instance.visibility} property ${cls.name}::$${name}`);
    throwError('Error', `Access to undeclared static property ${cls.name}::$${name}`);
  }
  if (!canAccessProp(found.decl, scope)) {
    throwError('Error', `Cannot access ${found.decl.visibility} property ${cls.name}::$${name}`);
  }
  if (reportTraitAccess && cls.kind === 'trait') {
    const emit = (): void =>
      deprecated(
        `Accessing static trait property ${cls.name}::$${name} is deprecated, it should only be accessed on a class using the trait`
      );
    if (warning) warning(emit);
    else emit();
  }
  initializeClassDefaults(cls);
  const ref = resolveStatic((cls.findStatic(name) ?? found).ref);
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
      const initial = current.propertyDefaults.get(prop);
      if (initial) resolvePropertyDefault(prop, initial);
      else if (prop.cls === current) prop.defaultValue?.();
    }
    for (const { ref } of current.staticProps.values()) resolveStatic(ref);
    initializedClasses.add(current);
  }
}

export function bindStaticPropertyReference(
  cls: PhpClass,
  name: string,
  scope: PhpClass | undefined,
  ref: Ref,
  valueFallback = false
): void {
  if (valueFallback) {
    staticPropRef(cls, name, scope);
    notice('Only variables should be assigned by reference');
    const old = staticPropRef(cls, name, scope, false);
    const useReference = old.isRef;
    const decl = cls.findStatic(name)?.decl;
    const value = !useReference && decl?.type ? coerceProperty(decl, ref.v) : ref.v;
    const assigned = old.assign(share(value));
    ref.v = useReference ? old.v : assigned;
    return;
  }
  if (cls.kind === 'trait') withOperandWarnings(bind);
  else bind();

  function bind(warning?: UpdateWarning, pending?: () => PhpThrow | undefined): Value {
    const old = staticPropRef(cls, name, scope, true, warning);
    const found = cls.findStatic(name);
    if (!found || old === ref) return (old === ref && dropped(old), null);
    return rt().withPropertyDiagnostic(pending?.(), () => {
      if (found.decl.type) attachPropertyReference(ref, found.decl);
      ref.isRef = true;
      ref.rc++;
      old.rc--;
      found.decl.cls.staticProps.set(name, { ...found, ref });
      dropped(old.v);
      return null;
    });
  }
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

export function objectToArray(object: PhpObject, indexed?: Iterable<[bigint, Value]>): PhpArray {
  const array = new PhpArray();
  for (const [key, value] of indexed ?? []) array.set(key, share(value));
  for (const [key, slot] of object.props) {
    if (slot === UNINIT) continue;
    const decl = declForKey(object.cls, key);
    let arrayKey = key;
    if (decl?.visibility === 'protected') arrayKey = `\0*\0${decl.name}`;
    array.setSlot(normalizeKeyString(arrayKey), copyValueSlot(slot, indexed !== undefined));
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
