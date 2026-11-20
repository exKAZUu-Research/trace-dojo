import type { ExecutionBudget } from '../interpreter/limits';
import type { PathRes } from './annotations';
import type { Expr } from './ast';
import { forEachDirect, walkBlock } from './astWalk';
import { settleStrings } from './capacity';
import type { Checker } from './checker';
import type { Known } from './constLint';
import { Interpreter } from './interpreter';
import { compileError } from './items';
import { Runtime } from './runtime';
import { concreteType, typeKey } from './runtimeTypes';
import { type ConstDef, type FnDef, hasParams, hasVars, resolve, type Subst, type Type } from './types';
import { EnumValue, isPlace, RangeValue, sliceItems, SliceView, StructValue, type Value } from './values';

type ConstPath = Extract<PathRes, { kind: 'const' }>;
interface FunctionInstance {
  fn: FnDef;
  typeArgs: Type[];
}

export function evaluateConstants(checker: Checker, budget: ExecutionBudget): void {
  const { program } = checker;
  const constants = program.consts.filter((def) => !def.module.isStd && def.ast.value);
  if (constants.length === 0) return;
  const interpreter = new Interpreter(program, checker, false);
  interpreter.runtime = new Runtime(undefined, budget);
  try {
    const evaluation = new ConstantEvaluation(interpreter, checker, budget);
    evaluation.run(constants);
  } finally {
    settleStrings();
    interpreter.restoreOperations();
  }
}

class ConstantEvaluation {
  private readonly checked = new Map<ConstDef | FnDef, Set<string>>();
  private readonly pending: FunctionInstance[] = [];

  constructor(
    private readonly interpreter: Interpreter,
    private readonly checker: Checker,
    private readonly budget: ExecutionBudget
  ) {}

  run(constants: ConstDef[]): void {
    for (const def of constants) if (!def.impl?.params.length) this.validate(def, []);
    this.evaluatePatterns();
    if (!constants.some((def) => def.impl?.params.length)) return;
    for (const res of this.checker.annotations.paths.values()) {
      if (res.kind === 'const') this.validate(res.def, instantiations(res.typeArgs));
    }
    const main = this.checker.program.root.values.get('main')?.binding;
    if (main?.kind === 'fn') this.pending.push({ fn: main.def, typeArgs: [] });
    for (const instance of this.pending) this.walkFunction(instance);
  }

  private evaluatePatterns(): void {
    const { constPatterns, paths } = this.checker.annotations;
    for (const pattern of constPatterns.keys()) {
      const res = paths.get(pattern) as ConstPath;
      if (hasParams(res.type) || this.dependsOnParameters(res, new Set())) {
        compileError(pattern.span, '定数パターンは総称型の型引数に依存できません。');
      }
      const value = this.interpreter.evaluateCheckedConstant(res.def, instantiations(res.typeArgs));
      constPatterns.set(pattern, patternValue(value, this.budget));
    }
  }

  private dependsOnParameters(path: ConstPath, visited: Set<ConstDef>): boolean {
    if (!path.typeArgs.some(hasParams)) return false;
    if (!path.def.ast.value || visited.has(path.def)) return false;
    visited.add(path.def);
    const subst = new Map(path.def.impl?.params.map((param, index) => [param, path.typeArgs[index]]));
    let dependent = false;
    const visit = (expr: Expr): void => {
      if (dependent) return;
      this.budget.spend();
      const { annotations } = this.checker;
      const target = annotations.paths.get(expr) ?? annotations.methods.get(expr);
      if (target && 'typeArgs' in target) {
        const typeArgs = instantiations(target.typeArgs, subst);
        dependent =
          'kind' in target && target.kind === 'const'
            ? this.dependsOnParameters({ ...target, typeArgs }, visited)
            : typeArgs.some(hasParams);
      }
      forEachDirect(expr, visit);
    };
    visit(path.def.ast.value);
    visited.delete(path.def);
    return dependent;
  }

  private walkFunction(instance: FunctionInstance): void {
    const { fn, typeArgs } = this.interpreter.resolveFunctionInstance(instance.fn, instance.typeArgs);
    const body = fn.ast?.body;
    if (!body || !this.firstInstance(fn, typeArgs)) return;
    const subst = new Map(fn.params.map((param, index) => [param, typeArgs[index]]));
    const { annotations } = this.checker;
    const visit = (expr: Expr): void => {
      this.budget.spend();
      const path = annotations.paths.get(expr);
      if (path?.kind === 'const') this.validate(path.def, instantiations(path.typeArgs, subst));
      if (path?.kind === 'fn') this.enqueue(path, subst);
      const method = annotations.methods.get(expr);
      if (method) this.enqueue(method, subst);
      forEachDirect(expr, visit);
    };
    walkBlock(body, visit);
  }

  private enqueue(instance: FunctionInstance, subst: Subst): void {
    const typeArgs = instantiations(instance.typeArgs, subst);
    if (typeArgs.every(concrete)) this.pending.push({ fn: instance.fn, typeArgs });
  }

  private validate(def: ConstDef, types: Type[]): void {
    if (!def.ast.value || !types.every(concrete) || !this.firstInstance(def, types)) return;
    this.interpreter.evaluateCheckedConstant(def, types);
  }

  private firstInstance(def: ConstDef | FnDef, types: Type[]): boolean {
    let instances = this.checked.get(def);
    if (!instances) {
      instances = new Set();
      this.checked.set(def, instances);
    }
    const key = JSON.stringify(types.map(typeKey));
    if (instances.has(key)) return false;
    instances.add(key);
    return true;
  }
}

function instantiations(types: Type[], subst?: Subst): Type[] {
  return types.map((type) => resolve(subst ? concreteType(type, subst) : type, true));
}

function concrete(type: Type): boolean {
  return !hasParams(type) && !hasVars(type);
}

function patternValue(value: Value, budget: ExecutionBudget): Known | undefined {
  budget.spend();
  if (isPlace(value)) return patternValue(value.get(), budget);
  if (value === undefined || typeof value !== 'object') return value;
  if (value instanceof EnumValue || value instanceof StructValue) {
    const variant = value instanceof EnumValue ? value.variant : 0;
    return {
      ctor: `v${variant}`,
      fields: new Map(
        value.def.variants[variant].fields.map((f, i) => [f.name, patternValue(value.fields[i], budget)])
      ),
    };
  }
  if (Array.isArray(value) || value instanceof SliceView) {
    return {
      ctor: 'tuple',
      fields: new Map(sliceItems(value).map((item, i) => [String(i), patternValue(item, budget)])),
    };
  }
  if (value instanceof RangeValue) {
    return {
      fields: new Map([
        ['start', patternValue(value.start, budget)],
        ['end', patternValue(value.end, budget)],
      ]),
    };
  }
  return undefined;
}
