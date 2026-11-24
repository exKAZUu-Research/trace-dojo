import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import type { TypeEntity } from './entities';
import { type Pred, prune, splitApp, type TVar, type Type } from './types';
import { chargeTypeWork } from './typeWorkBudget';

/** Names the variables of the types printed in one message alike: `a`, `b`, ... in order of appearance. */
export class TypePrinter {
  private readonly names = new Map<TVar, string>();
  private readonly used = new Set<string>();
  private remaining = LIMITS.maxStringLength;
  private depth = 0;

  constructor(private readonly genNames: readonly string[] = []) {}

  show(type: Type, precedence = 0): string {
    chargeTypeWork();
    if (++this.depth > LIMITS.maxCallDepth) throw new ExecutionLimitError('operations');
    try {
      const text = this.showInner(type, precedence);
      this.remaining -= text.length;
      if (this.remaining < 0) throw new ExecutionLimitError('operations');
      return text;
    } finally {
      this.depth--;
    }
  }

  private showInner(type: Type, precedence: number): string {
    const pruned = prune(type);
    switch (pruned.tag) {
      case 'tvar': {
        return this.nameOf(pruned);
      }
      case 'tgen': {
        return this.genNames[pruned.index] ?? `t${pruned.index}`;
      }
      case 'tcon': {
        const entity = pruned.entity;
        if (entity.special === 'list') return '[]';
        return entity.name;
      }
      case 'tap': {
        return this.showApp(pruned, precedence);
      }
      case 'forall': {
        const vars = pruned.vars.map((variable) => this.nameOf(variable)).join(' ');
        const context =
          pruned.preds.length === 0
            ? ''
            : pruned.preds.length === 1
              ? `${this.showPred(pruned.preds[0])} => `
              : `(${pruned.preds.map((pred) => this.showPred(pred)).join(', ')}) => `;
        const text = `forall ${vars}. ${context}${this.show(pruned.body)}`;
        return precedence > 0 ? `(${text})` : text;
      }
    }
  }

  private showApp(type: Type, precedence: number): string {
    const { head, args } = splitApp(type);
    if (head.tag === 'tcon') {
      const special = this.showSpecial(head.entity, args, precedence);
      if (special !== undefined) return special;
    }
    const text = [this.show(head, 2), ...args.map((arg) => this.show(arg, 2))].join(' ');
    return precedence > 1 ? `(${text})` : text;
  }

  /** An application of a type GHC writes in a syntax of its own: functions, lists, and the kinds of tuples. */
  private showSpecial(entity: TypeEntity, args: Type[], precedence: number): string | undefined {
    const arrow = (text: string): string => (precedence > 0 ? `(${text})` : text);
    if (entity.name === 'FUN' && entity.module === 'GHC.Types' && args.length === 3) {
      const multiplicity = prune(args[0]);
      const mark = multiplicity.tag === 'tcon' && multiplicity.entity.name === 'One' ? '1' : this.show(args[0], 2);
      return arrow(`${this.show(args[1], 1)} %${mark} -> ${this.show(args[2], 0)}`);
    }
    if (entity.special === 'function' && args.length === 2) {
      return arrow(`${this.show(args[0], 1)} -> ${this.show(args[1], 0)}`);
    }
    if (entity.special === 'list' && args.length === 1) {
      const elem = prune(args[0]);
      if (elem.tag === 'tcon' && elem.entity.name === 'Char' && elem.entity.module === 'GHC.Types') return 'String';
      return `[${this.show(args[0])}]`;
    }
    if (args.length !== entity.arity) return undefined;
    const parts = args.map((arg) => this.show(arg));
    if (entity.special === 'unboxedTuple') return parts.length === 0 ? '(# #)' : `(# ${parts.join(', ')} #)`;
    if (entity.special === 'unboxedSum') return `(# ${parts.join(' | ')} #)`;
    if (entity.special === 'tuple') return `(${parts.join(', ')})`;
    return undefined;
  }

  showPred(pred: Pred): string {
    if (pred.cls.packed) {
      const args = splitApp(pred.type).args.map((arg) => ` ${this.show(arg, 2)}`);
      return `${pred.cls.name}${args.join('')}`;
    }
    return `${pred.cls.name} ${this.show(pred.type, 2)}`;
  }

  private nameOf(variable: TVar): string {
    let name = this.names.get(variable);
    if (name) return name;
    const base = variable.name ?? 'a';
    name = base;
    for (let index = 0; this.used.has(name); index++) {
      chargeTypeWork();
      name = `${base}${index}`;
    }
    this.used.add(name);
    this.names.set(variable, name);
    return name;
  }
}
