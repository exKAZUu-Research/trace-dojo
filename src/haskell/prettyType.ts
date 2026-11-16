import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
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
    }
  }

  // code-gauge-allow functionCognitiveComplexity 18 -- Each branch is one of GHC's type printing forms: lists, tuples, functions, and applications.
  private showApp(type: Type, precedence: number): string {
    const { head, args } = splitApp(type);
    if (head.tag === 'tcon') {
      const entity = head.entity;
      if (entity.special === 'function' && args.length === 2) {
        const text = `${this.show(args[0], 1)} -> ${this.show(args[1], 0)}`;
        return precedence > 0 ? `(${text})` : text;
      }
      if (entity.special === 'list' && args.length === 1) {
        const elem = prune(args[0]);
        if (elem.tag === 'tcon' && elem.entity.name === 'Char' && elem.entity.module === 'GHC.Types') return 'String';
        return `[${this.show(args[0])}]`;
      }
      if (entity.special === 'tuple' && args.length === entity.arity) {
        return `(${args.map((arg) => this.show(arg)).join(', ')})`;
      }
    }
    const text = [this.show(head, 2), ...args.map((arg) => this.show(arg, 2))].join(' ');
    return precedence > 1 ? `(${text})` : text;
  }

  showPred(pred: Pred): string {
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

export function showType(type: Type): string {
  return new TypePrinter().show(type);
}
