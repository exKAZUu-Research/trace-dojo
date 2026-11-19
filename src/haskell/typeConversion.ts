import { FUNCTION_TYPE, tupleType } from './builtinTypes';
import type { ClassEntity } from './entities';
import { compileError, unsupportedError } from './errors';
import { freshKind, instantiateKind } from './kindTemplates';
import { directClassConstraint, type RConstraint, type RType } from './rast';
import type { Span } from './syntax';
import {
  CONSTRAINT,
  freshKindVar,
  freshTypeVar,
  instantiateType,
  type Kind,
  kindArrow,
  parameterKinds,
  type Pred,
  prune,
  pruneKind,
  showKind,
  STAR,
  tap,
  tcon,
  type Type,
  unifyKinds,
} from './types';

export class TypeConversion {
  private kindInstances: { kind: Kind; expected: Kind; span: Span }[] = [];
  private unsupportedFeature: { span: Span; feature: string } | undefined;

  predicates(
    context: readonly RConstraint[],
    vars: ReadonlyMap<string, Type>,
    varKinds: ReadonlyMap<string, Kind>
  ): Pred[] {
    const predicates: Pred[] = [];
    for (const constraint of context) {
      const direct = directClassConstraint(constraint);
      if (direct)
        predicates.push({
          cls: direct.cls,
          type: this.convert(direct.type, vars, varKinds, this.classKind(direct.cls, direct.span)),
        });
      else {
        this.convert(constraint, vars, varKinds, CONSTRAINT);
        this.markUnsupported(constraint.span);
      }
    }
    return predicates;
  }

  superclasses(context: readonly RConstraint[], parameter: string, kind: Kind): void {
    const vars = new Map<string, Type>([[parameter, { tag: 'tgen', index: 0 }]]);
    const kinds = new Map([[parameter, kind]]);
    for (const constraint of context) {
      for (const pred of this.predicates([constraint], vars, kinds)) {
        const type = prune(pred.type);
        if (type.tag !== 'tgen' || type.index !== 0)
          this.markUnsupported(constraint.span, '型変数以外のスーパークラス制約');
      }
    }
  }

  derivingClass(type: RType): ClassEntity | undefined {
    if (type.k === 'class') return type.entity;
    this.convert(type, new Map(), new Map(), kindArrow(freshKindVar(), CONSTRAINT));
    this.markUnsupported(type.span);
    return;
  }

  convert(type: RType, vars: ReadonlyMap<string, Type>, varKinds: ReadonlyMap<string, Kind>, expected: Kind): Type {
    const { type: result, kind } = this.convertTypeKind(type, vars, varKinds);
    if (!unifyKinds(kind, expected)) {
      throw compileError(
        type.span,
        `型の種類（カインド）が合いません。種類 ${showKind(expected)} の型が期待されているところに、種類 ${showKind(kind)} の型があります。`
      );
    }
    return result;
  }

  checkKinds(specialize = false): void {
    for (const { kind, expected, span } of this.kindInstances) {
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
        const kind = kindArrow(this.classKind(type.entity, type.span), CONSTRAINT);
        this.markUnsupported(type.span);
        return { type: freshTypeVar(kind, 0), kind };
      }
      case 'tuple': {
        return this.convertTuple(type, vars, varKinds);
      }
      case 'fun': {
        const from = this.convert(type.from, vars, varKinds, STAR);
        const to = this.convert(type.to, vars, varKinds, STAR);
        return { type: tap(tcon(FUNCTION_TYPE), from, to), kind: STAR };
      }
      case 'con':
      case 'app': {
        return this.convertAppliedType(type, vars, varKinds);
      }
    }
  }

  private convertTuple(
    type: Extract<RType, { k: 'tuple' }>,
    vars: ReadonlyMap<string, Type>,
    varKinds: ReadonlyMap<string, Kind>
  ): { type: Type; kind: Kind } {
    const parts = type.elems.map((elem) => this.convertTypeKind(elem, vars, varKinds));
    const kind = parts.some((part) => pruneKind(part.kind).tag === 'constraint') ? CONSTRAINT : STAR;
    for (const [index, part] of parts.entries())
      if (!unifyKinds(part.kind, kind))
        throw compileError(type.elems[index].span, 'タプルの型の種類（カインド）が合いません。');
    if (kind === CONSTRAINT) {
      this.markUnsupported(type.span);
      return { type: freshTypeVar(kind, 0), kind };
    }
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
    if (head.k === 'con' && head.entity.sort === 'synonym') {
      const entity = head.entity;
      if (args.length < entity.arity) {
        throw compileError(type.span, `型シノニム ${entity.name} には ${entity.arity} 個の型引数が要ります。`);
      }
      const synonymArgs = args.slice(0, entity.arity).map((arg) => this.convertTypeKind(arg, vars, varKinds));
      const appliedKind = this.instantiateKind(entity, entity.kind, head.span);
      const paramKinds = parameterKinds(appliedKind).slice(0, entity.arity);
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
        ? { type: tcon(head.entity) as Type, kind: this.instantiateKind(head.entity, head.entity.kind, head.span) }
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
      const converted = this.convertTypeKind(arg, vars, varKinds);
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
