import { mapGraph } from './typeGraph';
import { freshKindVar, type Kind, kindArrow, type KindVar, pruneKind } from './types';

/** A kind-polymorphic owner's kind, with the kinds of the variables its kind signature binds, in order. */
const templates = new WeakMap<object, { kind: Kind; binders: Kind[] }>();

export function rememberKind(owner: object, kind: Kind, binders: readonly Kind[] = []): void {
  // A binder the kind never mentions, `forall k. Type -> Type`, still takes a kind argument.
  if (binders.length === 0 && freshKind(kind).variables.length === 0) {
    templates.delete(owner);
    return;
  }
  const [template, ...templateBinders] = freshKinds([kind, ...binders]);
  templates.set(owner, { kind: template, binders: templateBinders });
}

/**
 * A fresh instance of an owner's kind, with the instance's kinds of the binders `rememberKind` was given, which kind
 * applications set.
 */
export function instantiateKind(owner: object, kind: Kind): { kind: Kind; polymorphic: boolean; binders: Kind[] } {
  const template = templates.get(owner);
  if (!template) return { kind, polymorphic: false, binders: [] };
  const [instance, ...binders] = freshKinds([template.kind, ...template.binders]);
  return { kind: instance, polymorphic: true, binders };
}

export function freshKind(kind: Kind): { kind: Kind; variables: KindVar[] } {
  const variables: KindVar[] = [];
  const result = mapGraph<Kind>(
    kind,
    pruneKind,
    (node) => (node.tag === 'arrow' ? [node.from, node.to] : node.tag === 'data' ? node.args : []),
    (node, mapped) => {
      if (node.tag === 'kvar') {
        const variable = freshKindVar();
        variables.push(variable);
        return variable;
      }
      if (node.tag === 'data') return { tag: 'data', entity: node.entity, args: mapped };
      return node.tag === 'arrow' ? kindArrow(mapped[0], mapped[1]) : node;
    }
  );
  return { kind: result, variables };
}

/**
 * Copies kinds with fresh variables for the kind variables they hold, the same variable alike, as instantiating a
 * scheme of a kind-polymorphic type does.
 */
export function freshKinds(kinds: readonly Kind[]): Kind[] {
  if (kinds.length === 0) return [];
  let whole: Kind = kinds.at(-1) as Kind;
  for (const kind of kinds.slice(0, -1).toReversed()) whole = kindArrow(kind, whole);
  const result: Kind[] = [];
  let current = freshKind(whole).kind;
  for (let index = 0; index < kinds.length - 1; index++) {
    const arrow = pruneKind(current) as { tag: 'arrow'; from: Kind; to: Kind };
    result.push(arrow.from);
    current = arrow.to;
  }
  result.push(current);
  return result;
}
