// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import type { ClassDecl, Expr } from './ast';
import { debugType } from './conversions';
import { reportUncaughtWarning, throwError } from './errors';
import { strictEquals } from './operators';
import { share } from './places';
import { FatalError, PhpThrow } from './runtime';
import { coerce, describeType, NO_MATCH, typeToString } from './types';
import { type ClassConst, PhpArray, type PhpClass, type Value, visibilityRank } from './values';
import { isSubtype } from './variance';

/** Evaluates a constant expression of a class in that class's scope, which the interpreter provides. */
export let evaluateInClass: (e: Expr, cls: PhpClass) => Value = () => null;

export function setClassEvaluator(run: (e: Expr, cls: PhpClass) => Value): void {
  evaluateInClass = run;
}

export function addConst(cls: PhpClass, ast: ClassDecl['consts'][number]): void {
  const constant: ClassConst = {
    name: ast.name,
    initializer: ast.value,
    cls,
    visibility: ast.visibility,
    isFinal: ast.isFinal,
    type: ast.type,
    evaluate: () => evaluateInClass(ast.value, cls),
  };
  const inherited = cls.consts.get(ast.name);
  if (inherited) checkConstantOverride(cls, constant, inherited, ast.row);
  cls.consts.set(ast.name, constant);
}

function checkConstantOverride(cls: PhpClass, constant: ClassConst, inherited: ClassConst, row: number): void {
  if (inherited.cls === cls || inherited.visibility === 'private') return;
  const name = constant.name;
  if (inherited.isFinal) {
    throw new FatalError(
      `${constant.cls.name}::${name} cannot override final constant ${inherited.cls.name}::${name}`,
      row
    );
  }
  if (visibilityRank(constant.visibility) < visibilityRank(inherited.visibility)) {
    const weaker = inherited.visibility === 'protected' ? ' or weaker' : '';
    throw new FatalError(
      `Access level to ${cls.name}::${name} must be ${inherited.visibility} (as in class ${inherited.cls.name})${weaker}`,
      row
    );
  }
  if (inherited.type && (!constant.type || !isSubtype(constant.type, constant.cls, inherited.type, inherited.cls))) {
    throw new FatalError(
      `Type of ${cls.name}::${name} must be compatible with ${inherited.cls.name}::${name} of type ${describeType(inherited.type, inherited.cls)}`,
      row
    );
  }
}

// code-gauge-allow functionCognitiveComplexity 18 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
export function linkInterfaceConstants(cls: PhpClass, row: number): void {
  for (const iface of cls.interfaces) {
    for (const [name, constant] of iface.consts) {
      const existing = cls.consts.get(name);
      if (!existing) cls.consts.set(name, constant);
      else if (existing !== constant) {
        if (constant.isFinal) checkConstantOverride(cls, existing, constant, row);
        if (existing.cls !== constant.cls && existing.cls !== cls) {
          throw new FatalError(
            `Class ${cls.name} inherits both ${existing.cls.name}::${name} and ${constant.cls.name}::${name}, which is ambiguous`,
            row
          );
        }
        checkConstantOverride(cls, existing, constant, row);
      }
    }
  }
}

interface TraitConstantConflict {
  existing: ClassConst;
  constant: ClassConst;
  first: string;
  trait: PhpClass;
}

export function applyTraitConstants(cls: PhpClass, trait: PhpClass, origins: Map<string, string>, row: number): void {
  for (const [name, source] of trait.consts) {
    const initializer = source.initializer;
    const constant: ClassConst = {
      name,
      cls,
      visibility: source.visibility,
      isFinal: source.isFinal,
      type: source.type,
      initializer,
      evaluate: initializer ? () => evaluateInClass(initializer, cls) : source.evaluate,
    };
    const existing = cls.consts.get(name);
    if (existing && (existing.cls === cls || origins.has(name))) {
      checkTraitConstant(cls, { existing, constant, first: origins.get(name) ?? cls.name, trait }, row);
    } else {
      if (existing) checkConstantOverride(cls, constant, existing, row);
      cls.consts.set(name, constant);
      origins.set(name, trait.name);
    }
  }
}

// code-gauge-allow functionCognitiveComplexity 16 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function checkTraitConstant(cls: PhpClass, conflict: TraitConstantConflict, row: number): void {
  const { existing, constant, first, trait } = conflict;
  const sameType =
    (!existing.type && !constant.type) ||
    (existing.type &&
      constant.type &&
      isSubtype(existing.type, cls, constant.type, trait, true) &&
      isSubtype(constant.type, trait, existing.type, cls, true));
  let sameValue = false;
  let evaluationFailed = false;
  if (existing.visibility === constant.visibility && existing.isFinal === constant.isFinal && sameType) {
    try {
      const left = existing.initializer ? evaluateInClass(existing.initializer, cls) : existing.value;
      const right = constant.initializer ? evaluateInClass(constant.initializer, cls) : constant.value;
      sameValue = left !== undefined && right !== undefined && strictEquals(left, right);
    } catch (error) {
      if (!(error instanceof PhpThrow)) throw error;
      evaluationFailed = true;
      reportUncaughtWarning(error.object);
    }
  }

  if (!sameValue) {
    throw new FatalError(
      `${first} and ${trait.name} define the same constant (${constant.name}) in the composition of ${cls.name}. However, the definition differs and is considered incompatible. Class was composed`,
      row,
      false,
      !evaluationFailed
    );
  }
}

export function classConstant(
  cls: PhpClass,
  name: string,
  scope: PhpClass | undefined,
  displayName = cls.name,
  trackEvaluation = true
): Value {
  const constant = cls.findConst(name);
  if (!constant) throwError('Error', `Undefined constant ${displayName}::${name}`);
  if (!canAccessConstant(constant, scope))
    throwError('Error', `Cannot access ${constant.visibility} constant ${displayName}::${name}`);
  if (cls.kind === 'trait') throwError('Error', `Cannot access trait constant ${displayName}::${name} directly`);
  return share(resolveConstant(constant, displayName, trackEvaluation));
}

export function initializeClassConstants(cls: PhpClass): void {
  for (const constant of cls.consts.values()) {
    if (constant.value === undefined) resolveConstant(constant, constant.cls.name, true);
  }
}

function resolveConstant(constant: ClassConst, displayName: string, trackEvaluation: boolean): Value {
  const { name } = constant;
  if (constant.value === undefined) {
    if (constant.evaluating) throwError('Error', `Cannot declare self-referencing constant ${displayName}::${name}`);
    if (trackEvaluation) constant.evaluating = true;
    try {
      let value = (constant.evaluate as () => Value)();
      if (constant.type) {
        const coerced = coerce(value, constant.type, { strict: true, internal: false, scope: constant.cls });
        if (coerced === NO_MATCH) {
          throwError(
            'TypeError',
            `Cannot assign ${debugType(value)} to class constant ${constant.cls.name}::${name} of type ${typeToString(constant.type)}`
          );
        }
        value = coerced;
      }
      constant.value = value;
      if (value instanceof PhpArray) value.persistentHolder = true;
    } finally {
      if (trackEvaluation) constant.evaluating = false;
    }
  }
  return constant.value;
}

export function canAccessConstant(constant: ClassConst, scope: PhpClass | undefined): boolean {
  return (
    constant.visibility === 'public' ||
    (scope !== undefined &&
      (constant.visibility === 'private'
        ? scope === constant.cls
        : scope.isSubclassOf(constant.cls) || constant.cls.isSubclassOf(scope)))
  );
}
