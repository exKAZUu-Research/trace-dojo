import type { AlternativeNode, CapturingGroupNode, Node, RegexNode } from 'oniguruma-parser/parser';
import { traverse } from 'oniguruma-parser/traverser';

import { LIMITS } from '../interpreter/limits';
import { RegexpEncodingError } from './regexpEscapes';
import { UnsupportedFeatureError } from './runtime';

type Callable = RegexNode | CapturingGroupNode;
type Recursion = 'none' | 'required' | 'nonprogress';
interface Analysis {
  groups: Map<string | number, Callable[]>;
  progressing: Set<Node>;
  target: Callable;
  active: Set<Node>;
  spend(): void;
}

// code-gauge-allow functionCognitiveComplexity 17 -- Indexing, monotone progress analysis and per-call termination checks share one bounded budget.
// code-gauge-allow functionNcss 35 -- Indexing, monotone progress analysis and per-call termination checks share one bounded budget.
export function validateRegexpRecursion(root: RegexNode): void {
  const groups = new Map<string | number, Callable[]>([[0, [root]]]);
  const nodes: Node[] = [];
  const calls = new Set<string | number>();
  let operations = 0;
  const spend = (): void => {
    if (++operations > LIMITS.maxOperations) throw new UnsupportedFeatureError('複雑な再帰構造の正規表現');
  };
  traverse(root, {
    '*': {
      exit: ({ node }) => {
        spend();
        nodes.push(node);
      },
    },
    CapturingGroup({ node }) {
      groups.set(node.number, [node]);
      if (node.name !== undefined) groups.set(node.name, [...(groups.get(node.name) ?? []), node]);
    },
    Subroutine({ node }) {
      calls.add(node.ref);
    },
  });
  if (calls.size === 0) return;
  const progressing = new Set<Node>();
  let changed: boolean;
  do {
    changed = false;
    for (const node of nodes) {
      spend();
      if (!progressing.has(node) && consumes(node, progressing, groups)) {
        progressing.add(node);
        changed = true;
      }
    }
  } while (changed);
  for (const reference of calls) {
    const target = groups.get(reference)?.[0];
    if (!target) throw new SyntaxError('invalid subroutine reference');
    const analysis: Analysis = { groups, progressing, target, active: new Set(), spend };
    if (alternatives(target.body, true, analysis) !== 'none') throw new RegexpEncodingError('never ending recursion');
  }
}

function consumes(node: Node, progressing: Set<Node>, groups: Analysis['groups']): boolean {
  switch (node.type) {
    case 'Character':
    case 'CharacterClass':
    case 'CharacterClassRange':
    case 'CharacterSet': {
      return true;
    }
    case 'Alternative': {
      return node.body.some((child) => progressing.has(child));
    }
    case 'Regex':
    case 'Group':
    case 'CapturingGroup': {
      return node.body.every((child) => progressing.has(child));
    }
    case 'Quantifier': {
      return node.min > 0 && progressing.has(node.body);
    }
    case 'Backreference':
    case 'Subroutine': {
      const targets = groups.get(node.ref);
      return targets !== undefined && targets.every((target) => progressing.has(target));
    }
    default: {
      return false;
    }
  }
}

function alternatives(branches: AlternativeNode[], head: boolean, analysis: Analysis): Recursion {
  let required = true;
  for (const branch of branches) {
    const result = sequence(branch, head, analysis);
    if (result === 'nonprogress') return result;
    if (result === 'none') required = false;
  }
  return required ? 'required' : 'none';
}

function sequence(branch: AlternativeNode, head: boolean, analysis: Analysis): Recursion {
  let required = false;
  for (const node of branch.body) {
    const result = recursion(node, head, analysis);
    if (result === 'nonprogress') return result;
    if (result === 'required') required = true;
    if (analysis.progressing.has(node)) head = false;
  }
  return required ? 'required' : 'none';
}

function recursion(node: Node, head: boolean, analysis: Analysis): Recursion {
  analysis.spend();
  if (node === analysis.target) return head ? 'nonprogress' : 'required';
  if (analysis.active.has(node)) return 'none';
  if (node.type === 'Subroutine') {
    const target = analysis.groups.get(node.ref)?.[0];
    return target ? recursion(target, head, analysis) : 'none';
  }
  if (node.type === 'Quantifier') {
    const result = recursion(node.body, head, analysis);
    return result === 'required' && node.min === 0 ? 'none' : result;
  }
  if (node.type === 'CharacterClass') return 'none';
  if (node.type === 'Alternative') return sequence(node, head, analysis);
  if ('body' in node) {
    analysis.active.add(node);
    const result = alternatives(node.body, head, analysis);
    analysis.active.delete(node);
    return result;
  }
  return 'none';
}
