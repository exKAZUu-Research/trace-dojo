import {
  classType,
  CONSTRAINT_KIND,
  CONSTRAINT_TYPE_CLASS,
  constraintTupleType,
  FUNCTION_TYPE,
  MULTIPLICITY_FUNCTION_TYPE,
  MULTIPLICITY_KIND,
  tupleType,
  TYPE_KIND,
  UNIT_TYPE,
} from './builtinTypes';
import type { ClassEntity, ConInfo, TypeEntity } from './entities';
import { compileError, unsupportedError } from './errors';
import { freshKind, instantiateKind, rememberKind } from './kindTemplates';
import { directClassConstraint, expandSynonymHead, type RConstraint, type RType } from './rast';
import type { Span } from './syntax';
import {
  CONSTRAINT,
  freshKindVar,
  instantiateType,
  type Kind,
  kindArrow,
  parameterKinds,
  type Pred,
  prune,
  pruneKind,
  showKind,
  splitApp,
  STAR,
  tap,
  tcon,
  type TVar,
  type Type,
  unifyKinds,
} from './types';

const promotedKinds = new WeakSet<TypeEntity>();

/** A type of a constructor's field as the kind its promotion has there. */
function typeToKind(type: Type, params: readonly Kind[]): Kind {
  const { head, args } = splitApp(prune(type));
  if (head.tag === 'tgen') return params[head.index] ?? STAR;
  if (head.tag === 'tcon') {
    if (head.entity === TYPE_KIND) return STAR;
    if (head.entity === CONSTRAINT_KIND) return CONSTRAINT;
    if (head.entity === FUNCTION_TYPE && args.length === 2) {
      return kindArrow(typeToKind(args[0], params), typeToKind(args[1], params));
    }
    return { tag: 'data', entity: head.entity, args: args.map((arg) => typeToKind(arg, params)) };
  }
  return STAR;
}

/** A kind as the type it promotes from, which a type synonym used as a kind is applied to. */
function kindToType(kind: Kind): Type {
  const pruned = pruneKind(kind);
  if (pruned.tag === 'data') return tap(tcon(pruned.entity), ...pruned.args.map(kindToType));
  if (pruned.tag === 'arrow') return tap(tcon(FUNCTION_TYPE), kindToType(pruned.from), kindToType(pruned.to));
  if (pruned.tag === 'constraint') return tcon(CONSTRAINT_KIND);
  return tcon(TYPE_KIND);
}

/** The ids of the variables polymorphic types bind, which count down to stay apart from other variables'. */
let nextBoundId = -1;

export class TypeConversion {
  private kindInstances: { kind: Kind; expected: Kind; span: Span }[] = [];
  private unsupportedFeature: { span: Span; feature: string } | undefined;

  predicates(
    context: readonly RConstraint[],
    vars: ReadonlyMap<string, Type>,
    varKinds: ReadonlyMap<string, Kind>
  ): Pred[] {
    const predicates: Pred[] = [];
    for (const constraint of expandConstraintSynonyms(context)) {
      const direct = directClassConstraint(constraint);
      if (direct)
        predicates.push({
          cls: direct.cls,
          type: this.convert(direct.type, vars, varKinds, this.classKind(direct.cls, direct.span)),
        });
      else predicates.push(...constraintPreds(this.convert(constraint, vars, varKinds, CONSTRAINT)));
    }
    return predicates;
  }

  /** A class's superclass constraints, with the types they apply to in terms of the class's parameters. */
  superclasses(context: readonly RConstraint[], parameters: readonly string[], kinds: readonly Kind[]): Pred[] {
    const vars = new Map<string, Type>(parameters.map((name, index) => [name, { tag: 'tgen', index }]));
    const varKinds = new Map(parameters.map((name, index) => [name, kinds[index]]));
    return this.predicates(context, vars, varKinds);
  }

  derivingClass(type: RType): ClassEntity | undefined {
    const expanded = expandSynonymHead(type);
    if (expanded.k === 'class') return expanded.entity;
    this.convert(type, new Map(), new Map(), kindArrow(freshKindVar(), CONSTRAINT));
    this.markUnsupported(type.span);
    return;
  }

  convert(type: RType, vars: ReadonlyMap<string, Type>, varKinds: ReadonlyMap<string, Kind>, expected: Kind): Type {
    const { type: result, kind } = this.convertAtKind(type, vars, varKinds, expected);
    if (!unifyKinds(kind, expected)) {
      throw compileError(
        type.span,
        `型の種類（カインド）が合いません。種類 ${showKind(expected)} の型が期待されているところに、種類 ${showKind(kind)} の型があります。`
      );
    }
    return result;
  }

  /** Converts a type where a type of kind `expected` goes, which reads `()` and tuples as constraints for Constraint. */
  private convertAtKind(
    type: RType,
    vars: ReadonlyMap<string, Type>,
    varKinds: ReadonlyMap<string, Kind>,
    expected: Kind
  ): { type: Type; kind: Kind } {
    return pruneKind(expected).tag === 'constraint' && isTupleForm(type)
      ? this.convertTuple(type, vars, varKinds, true)
      : this.convertTypeKind(type, vars, varKinds);
  }

  /** Whether PolyKinds lets a type of a polymorphic kind be used at different kinds. */
  polyKinds = false;

  checkKinds(specialize = false): void {
    for (const { kind, expected, span } of this.kindInstances) {
      // With PolyKinds, a type of an earlier group has a polymorphic kind, which each use instantiates on its own.
      if (this.polyKinds) continue;
      if (!unifyKinds(specialize ? expected : freshKind(expected).kind, kind)) {
        throw unsupportedError(span, '多相カインド（PolyKinds）');
      }
    }
    this.kindInstances = [];
    if (!specialize && this.unsupportedFeature)
      throw unsupportedError(this.unsupportedFeature.span, this.unsupportedFeature.feature);
  }

  private convertTypeKind(
    type: RType,
    vars: ReadonlyMap<string, Type>,
    varKinds: ReadonlyMap<string, Kind>
  ): { type: Type; kind: Kind } {
    switch (type.k) {
      case 'var': {
        const found = vars.get(type.name);
        if (!found) throw compileError(type.span, `型変数 ${type.name} がスコープにありません。`);
        return { type: found, kind: varKinds.get(type.name) as Kind };
      }
      case 'class': {
        const { entity } = type;
        const paramKinds = entity.packed ? parameterKinds(entity.packed.kind) : [this.classKind(entity, type.span)];
        let kind: Kind = CONSTRAINT;
        for (const paramKind of paramKinds.toReversed()) kind = kindArrow(paramKind, kind);
        return { type: tcon(classType(entity, kind)), kind };
      }
      case 'tuple': {
        return this.convertTuple(type, vars, varKinds);
      }
      case 'fun': {
        const from = this.convert(type.from, vars, varKinds, STAR);
        const to = this.convert(type.to, vars, varKinds, STAR);
        if (type.multiplicity) {
          const multiplicity = this.convert(type.multiplicity, vars, varKinds, MULTIPLICITY_KIND);
          return { type: tap(tcon(MULTIPLICITY_FUNCTION_TYPE), multiplicity, from, to), kind: STAR };
        }
        return { type: tap(tcon(FUNCTION_TYPE), from, to), kind: STAR };
      }
      case 'con':
      case 'app': {
        return this.convertAppliedType(type, vars, varKinds);
      }
      case 'kinded': {
        const kind = this.kindOf(type.kind, new Map());
        return { type: this.convert(type.type, vars, varKinds, kind), kind };
      }
      case 'kindapp': {
        let base: RType = type.type;
        while (base.k === 'app' || base.k === 'kindapp') base = base.k === 'app' ? base.fn : base.type;
        if (base.k !== 'con' || !base.entity.kindSpecified) {
          throw compileError(type.span, '種類の変数を決めていない型には、@ で種類を渡せません。');
        }
        const head = this.convertTypeKind(type.type, vars, varKinds);
        const parameter = pruneKind(head.kind);
        if (parameter.tag !== 'arrow' || !unifyKinds(parameter.from, this.kindOf(type.kind, new Map()))) {
          throw compileError(type.span, '型の種類（カインド）が合いません（種類の適用）。');
        }
        return head;
      }
      case 'forall': {
        const kindVars = new Map<string, Kind>();
        const bound = type.binders.map((binder): TVar => ({
          tag: 'tvar',
          id: nextBoundId--,
          kind: binder.kind ? this.kindOf(binder.kind, kindVars) : freshKindVar(),
          level: Number.MAX_SAFE_INTEGER,
          name: binder.name,
          skolem: true,
          bound: true,
          ...(binder.inferred ? { inferred: true } : {}),
        }));
        const innerVars = new Map(vars);
        const innerKinds = new Map(varKinds);
        for (const [index, binder] of type.binders.entries()) {
          innerVars.set(binder.name, bound[index]);
          innerKinds.set(binder.name, bound[index].kind);
        }
        const body = this.convert(type.body, innerVars, innerKinds, STAR);
        const preds = this.predicates(type.context, innerVars, innerKinds);
        return { type: { tag: 'forall', vars: bound, preds, body }, kind: STAR };
      }
    }
  }

  /**
   * Converts a kind written as a type: `Type` (or `*`), `Constraint`, arrows, kind variables, and data types used as
   * kinds, as DataKinds allows: `Bool`, `Symbol`, `[k]`, `Maybe k`.
   */
  kindOf(type: RType, kindVars: Map<string, Kind>): Kind {
    switch (type.k) {
      case 'fun': {
        return kindArrow(this.kindOf(type.from, kindVars), this.kindOf(type.to, kindVars));
      }
      case 'var': {
        let kind = kindVars.get(type.name);
        if (!kind) {
          kind = freshKindVar();
          kindVars.set(type.name, kind);
        }
        return kind;
      }
      case 'kinded': {
        return this.kindOf(type.type, kindVars);
      }
      case 'tuple': {
        return {
          tag: 'data',
          entity: tupleType(type.elems.length),
          args: type.elems.map((elem) => this.kindOf(elem, kindVars)),
        };
      }
      case 'forall': {
        for (const binder of type.binders) kindVars.set(binder.name, freshKindVar());
        return this.kindOf(type.body, kindVars);
      }
      case 'con':
      case 'app': {
        const args: RType[] = [];
        let head: RType = type;
        while (head.k === 'app') {
          args.unshift(head.arg);
          head = head.fn;
        }
        if (head.k !== 'con') break;
        if (head.entity === TYPE_KIND && args.length === 0) return STAR;
        if (head.entity === CONSTRAINT_KIND && args.length === 0) return CONSTRAINT;
        // A synonym used as a kind stands for its right side, with the arguments as written (kind variables
        // included), which kind checking may not have converted yet.
        if (head.entity.sort === 'synonym') {
          const expanded = expandSynonymHead(type);
          if (expanded !== type) return this.kindOf(expanded, kindVars);
        }
        if (head.entity.sort === 'synonym' && head.entity.synonym) {
          const expanded = instantiateType(
            head.entity.synonym,
            args.map((arg) => kindToType(this.kindOf(arg, kindVars)))
          );
          return typeToKind(expanded, []);
        }
        return { tag: 'data', entity: head.entity, args: args.map((arg) => this.kindOf(arg, kindVars)) };
      }
      default: {
        break;
      }
    }
    throw unsupportedError(type.span, 'この形の種類');
  }

  /**
   * The kind of a promoted constructor, from its constructor's type: `'Just` has kind `k -> Maybe k`, with a kind
   * variable for each parameter of the type, which each use instantiates afresh.
   */
  promotedKind(entity: TypeEntity): Kind {
    const con = entity.promotedFrom as ConInfo;
    if (!promotedKinds.has(entity)) {
      const params = parameterKinds(con.type.kind).map((): Kind => freshKindVar());
      let kind: Kind = { tag: 'data', entity: con.type, args: params };
      for (const field of con.fieldTypes.toReversed()) kind = kindArrow(typeToKind(field, params), kind);
      entity.kind = kind;
      rememberKind(entity, kind);
      promotedKinds.add(entity);
    }
    return entity.kind;
  }

  /**
   * A tuple: of constraints when one of its parts is a constraint or its place takes one (`()` there is the empty
   * constraint), of types otherwise.
   */
  private convertTuple(
    type: TupleForm,
    vars: ReadonlyMap<string, Type>,
    varKinds: ReadonlyMap<string, Kind>,
    isConstraint = false
  ): { type: Type; kind: Kind } {
    const elems = type.k === 'tuple' ? type.elems : [];
    const converted = elems.map((elem) => this.convertTypeKind(elem, vars, varKinds));
    const kind =
      isConstraint || converted.some((part) => pruneKind(part.kind).tag === 'constraint') ? CONSTRAINT : STAR;
    const parts = converted.map((part, index) => {
      const elem = elems[index];
      if (kind === CONSTRAINT && isTupleForm(elem) && pruneKind(part.kind).tag !== 'constraint') {
        return this.convertTuple(elem, vars, varKinds, true);
      }
      return part;
    });
    for (const [index, part] of parts.entries())
      if (!unifyKinds(part.kind, kind))
        throw compileError(elems[index].span, 'タプルの型の種類（カインド）が合いません。');
    if (kind === CONSTRAINT)
      return { type: tap(tcon(constraintTupleType(parts.length)), ...parts.map((part) => part.type)), kind };
    let result: Type = tcon(tupleType(parts.length));
    for (const part of parts) result = tap(result, part.type);
    return { type: result, kind };
  }

  private convertAppliedType(
    type: RType,
    vars: ReadonlyMap<string, Type>,
    varKinds: ReadonlyMap<string, Kind>
  ): { type: Type; kind: Kind } {
    const args: RType[] = [];
    let head: RType = type;
    while (head.k === 'app') {
      args.unshift(head.arg);
      head = head.fn;
    }
    if (head.k === 'con' && head.entity.sort === 'synonym' && !head.entity.synonym) {
      // A synonym of constraints stands for what it is written as.
      const expanded = expandSynonymHead(type);
      if (expanded !== type) return this.convertTypeKind(expanded, vars, varKinds);
    }
    if (head.k === 'con' && head.entity.sort === 'synonym') {
      const entity = head.entity;
      if (args.length < entity.arity) {
        throw compileError(type.span, `型シノニム ${entity.name} には ${entity.arity} 個の型引数が要ります。`);
      }
      const appliedKind = this.instantiateKind(entity, entity.kind, head.span);
      const paramKinds = parameterKinds(appliedKind).slice(0, entity.arity);
      const synonymArgs = args
        .slice(0, entity.arity)
        .map((arg, index) => this.convertAtKind(arg, vars, varKinds, paramKinds[index]));
      for (const [index, arg] of synonymArgs.entries()) {
        if (!unifyKinds(arg.kind, paramKinds[index])) {
          throw compileError(args[index].span, `型の種類（カインド）が合いません（${entity.name} の型引数）。`);
        }
      }
      const expanded = instantiateType(
        entity.synonym as Type,
        synonymArgs.map((arg) => arg.type)
      );
      let resultKind = appliedKind;
      for (let index = 0; index < entity.arity; index++) {
        resultKind = (pruneKind(resultKind) as { tag: 'arrow'; to: Kind }).to;
      }
      return this.applyTypeArgs({ type: expanded, kind: resultKind }, args.slice(entity.arity), vars, varKinds);
    }
    const converted =
      head.k === 'con'
        ? {
            type: tcon(head.entity) as Type,
            kind: this.instantiateKind(
              head.entity,
              head.entity.promotedFrom ? this.promotedKind(head.entity) : head.entity.kind,
              head.span
            ),
          }
        : this.convertTypeKind(head, vars, varKinds);
    return this.applyTypeArgs(converted, args, vars, varKinds);
  }

  private applyTypeArgs(
    head: { type: Type; kind: Kind },
    args: RType[],
    vars: ReadonlyMap<string, Type>,
    varKinds: ReadonlyMap<string, Kind>
  ): { type: Type; kind: Kind } {
    let { type: result, kind } = head;
    for (const arg of args) {
      const pruned = pruneKind(kind);
      const converted =
        pruned.tag === 'arrow'
          ? this.convertAtKind(arg, vars, varKinds, pruned.from)
          : this.convertTypeKind(arg, vars, varKinds);
      const resultKind = freshKindVar();
      if (!unifyKinds(kind, kindArrow(converted.kind, resultKind))) {
        throw compileError(
          arg.span,
          pruneKind(kind).tag === 'star'
            ? '型の種類（カインド）が合いません。型引数をとらない型に、型引数を書いています。'
            : '型の種類（カインド）が合いません。'
        );
      }
      result = tap(result, converted.type);
      kind = resultKind;
    }
    return { type: result, kind };
  }

  classKind(entity: ClassEntity, span: Span): Kind {
    return this.instantiateKind(entity, entity.tyvarKind, span);
  }

  private instantiateKind(owner: object, kind: Kind, span: Span): Kind {
    const instance = instantiateKind(owner, kind);
    if (instance.variables.length > 0) this.kindInstances.push({ kind: instance.kind, expected: kind, span });
    return instance.kind;
  }

  private markUnsupported(span: Span, feature = '制約を型として扱う機能（ConstraintKinds）'): void {
    this.unsupportedFeature ??= { span, feature };
  }
}

/** The constraints a context stands for, with its tuples of constraints and its synonyms expanded. */
function expandConstraintSynonyms(context: readonly RConstraint[]): RConstraint[] {
  const result: RConstraint[] = [];
  const pending = [...context].toReversed();
  while (pending.length > 0) {
    const constraint = expandSynonymHead(pending.pop() as RConstraint);
    if (constraint.k === 'tuple') pending.push(...constraint.elems.toReversed());
    else result.push(constraint);
  }
  return result;
}

/**
 * The constraints a constraint written as a type stands for: a class's when its head is a class, those of a tuple's
 * parts, or one of the class of constraint types when its head is a variable, which instantiating it makes a class.
 */
export function constraintPreds(type: Type): Pred[] {
  const { head, args } = splitApp(prune(type));
  if (head.tag === 'tcon' && head.entity.classOf) {
    const cls = head.entity.classOf;
    if (args.length === (cls.packed?.arity ?? 1)) {
      return [{ cls, type: cls.packed ? tap(tcon(cls.packed), ...args) : args[0] }];
    }
  }
  if (head.tag === 'tcon' && head.entity === constraintTupleType(args.length)) {
    return args.flatMap(constraintPreds);
  }
  return [{ cls: CONSTRAINT_TYPE_CLASS, type }];
}

/** A tuple, or `()`, the tuple of none, which a place that takes a constraint reads as the empty constraint. */
type TupleForm = Extract<RType, { k: 'tuple' }> | Extract<RType, { k: 'con' }>;

function isTupleForm(type: RType): type is TupleForm {
  return type.k === 'tuple' || (type.k === 'con' && type.entity === UNIT_TYPE);
}
