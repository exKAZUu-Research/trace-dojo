import { mapGraph } from './typeGraph';
import { freshKindVar, type Kind, kindArrow, type KindVar, pruneKind } from './types';

const templates = new WeakMap<object, Kind>();

export function rememberKind(owner: object, kind: Kind): void {
  const instance = freshKind(kind);
  if (instance.variables.length > 0) templates.set(owner, instance.kind);
  else templates.delete(owner);
}

export function instantiateKind(owner: object, kind: Kind): { kind: Kind; variables: KindVar[] } {
  const template = templates.get(owner);
  return template ? freshKind(template) : { kind, variables: [] };
}

export function freshKind(kind: Kind): { kind: Kind; variables: KindVar[] } {
  const variables: KindVar[] = [];
  const result = mapGraph<Kind>(
    kind,
    pruneKind,
    (node) => (node.tag === 'arrow' ? [node.from, node.to] : []),
    (node, mapped) => {
      if (node.tag === 'kvar') {
        const variable = freshKindVar();
        variables.push(variable);
        return variable;
      }
      return node.tag === 'arrow' ? kindArrow(mapped[0], mapped[1]) : node;
    }
  );
  return { kind: result, variables };
}
