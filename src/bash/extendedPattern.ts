import type { StepMeter } from './budget';

/** A pattern element that matches one character, as the plain matcher of `pattern.ts` reads it. */
export interface CharacterMatcher {
  matches(ch: string): boolean;
}

/** An element of an extended pattern: one character, `*`, or a group such as `+(a|b)` holding alternatives. */
export type ExtendedNode =
  | { readonly kind: 'character'; readonly matcher: CharacterMatcher }
  | { readonly kind: 'star' }
  | { readonly kind: 'group'; readonly operator: '?' | '*' | '+' | '@' | '!'; readonly alternatives: ExtendedNode[][] };

/**
 * A pattern with `extglob` groups, matched by computing the positions where each element can end, which handles
 * nested groups and `!(...)`, whose match is any text that none of its alternatives matches.
 */
export class ExtendedPattern {
  constructor(readonly nodes: readonly ExtendedNode[]) {}

  /** The positions where a match of the whole pattern starting at `start` in `chars[..limit]` can end. */
  endsFrom(chars: readonly string[], start: number, limit: number, spend: StepMeter): Set<number> {
    return new ExtendedMatch(chars, limit, spend).sequenceEnds(this.nodes, start);
  }
}

class ExtendedMatch {
  /** The ends of each group's alternatives by start position, which `*(...)` and `!(...)` revisit. */
  private readonly groupEnds = new Map<ExtendedNode, Map<number, Set<number>>>();

  constructor(
    private readonly chars: readonly string[],
    private readonly limit: number,
    private readonly spend: StepMeter
  ) {}

  sequenceEnds(nodes: readonly ExtendedNode[], start: number): Set<number> {
    let positions = new Set([start]);
    for (const node of nodes) {
      const next = new Set<number>();
      for (const position of positions) {
        for (const end of this.nodeEnds(node, position)) next.add(end);
      }
      positions = next;
      if (positions.size === 0) break;
    }
    return positions;
  }

  private nodeEnds(node: ExtendedNode, start: number): Iterable<number> {
    this.spend();
    switch (node.kind) {
      case 'character': {
        return start < this.limit && node.matcher.matches(this.chars[start]) ? [start + 1] : [];
      }
      case 'star': {
        return this.positionsFrom(start);
      }
      case 'group': {
        return this.groupMatchEnds(node, start);
      }
    }
  }

  private positionsFrom(start: number): number[] {
    return Array.from({ length: this.limit - start + 1 }, (_, offset) => start + offset);
  }

  private groupMatchEnds(node: Extract<ExtendedNode, { kind: 'group' }>, start: number): Iterable<number> {
    const once = this.alternativeEnds(node, start);
    switch (node.operator) {
      case '@': {
        return once;
      }
      case '?': {
        return new Set([start, ...once]);
      }
      case '*': {
        return this.repeated(node, new Set([start]));
      }
      case '+': {
        return this.repeated(node, once);
      }
      case '!': {
        return this.positionsFrom(start).filter((end) => !once.has(end));
      }
    }
  }

  /** The positions reached from `from` by repeating a group's alternatives any number of times. */
  private repeated(node: ExtendedNode & { kind: 'group' }, from: Set<number>): Set<number> {
    const reached = new Set(from);
    const pending = [...from];
    for (let position = pending.pop(); position !== undefined; position = pending.pop()) {
      for (const end of this.alternativeEnds(node, position)) {
        if (reached.has(end)) continue;
        reached.add(end);
        pending.push(end);
      }
    }
    return reached;
  }

  private alternativeEnds(node: ExtendedNode & { kind: 'group' }, start: number): Set<number> {
    let byStart = this.groupEnds.get(node);
    if (!byStart) {
      byStart = new Map();
      this.groupEnds.set(node, byStart);
    }
    const known = byStart.get(start);
    if (known) return known;
    const ends = new Set<number>();
    for (const alternative of node.alternatives) {
      for (const end of this.sequenceEnds(alternative, start)) ends.add(end);
    }
    byStart.set(start, ends);
    return ends;
  }
}
