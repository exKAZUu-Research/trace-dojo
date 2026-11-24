import type { CompilerBase } from './compilerBase';
import type { Entity } from './scopes';
import { fieldOf, type Syntax } from './syntax';

/** The node type of one element of a pack expansion, which binds the packs its pattern names to their elements. */
export const PACK_ELEMENT = '\0pack element';

/** One element of a pack expansion (`xs...`): the pattern, with each pack it names bound to an element. */
export interface PackElement extends Syntax {
  readonly bindings: ReadonlyMap<string, Entity>;
}

/** The packs a pattern names, outside any expansion it contains, with their elements. */
export function packsIn(
  compiler: CompilerBase,
  node: Syntax,
  found = new Map<string, Entity[]>()
): Map<string, Entity[]> {
  if (node.type === 'parameter_pack_expansion' || node.type === PACK_ELEMENT) return found;
  if (node.type === 'identifier' || node.type === 'type_identifier') {
    const entity = compiler.findName(node.text);
    if (entity?.kind === 'pack') found.set(node.text, entity.items);
  }
  for (const child of node.children) packsIn(compiler, child, found);
  return found;
}

/**
 * Expands the pack expansions among a list's nodes (`f(xs...)`, `{xs...}`, `Box<Ts...>`) into one node per element,
 * as C++20 [temp.variadic] instantiates them.
 */
export function expandPacks(compiler: CompilerBase, nodes: readonly Syntax[]): Syntax[] {
  if (!nodes.some((node) => node.type === 'parameter_pack_expansion')) return [...nodes];
  return nodes.flatMap((node) => {
    if (node.type !== 'parameter_pack_expansion') return [node];
    const pattern = (fieldOf(node, 'pattern') ?? node.children[0]) as Syntax;
    return packElements(compiler, pattern, node.row);
  });
}

/** The elements of the expansion of a pattern, one per element of the packs it names. */
export function packElements(compiler: CompilerBase, pattern: Syntax, row: number): PackElement[] {
  const packs = packsIn(compiler, pattern);
  if (packs.size === 0) return compiler.error(row, `${pattern.text}... の中に、展開するパラメータパックがありません。`);
  const lengths = new Set([...packs.values()].map((items) => items.length));
  if (lengths.size > 1) return compiler.error(row, '長さの違うパラメータパックは、一緒には展開できません。');
  const [length] = lengths;
  return Array.from({ length }, (_, index) => {
    const bindings = new Map<string, Entity>();
    for (const [name, items] of packs) bindings.set(name, items[index]);
    return { ...pattern, type: PACK_ELEMENT, field: pattern.field, all: [pattern], children: [pattern], bindings };
  });
}

/** Compiles a pack element's pattern where its packs name their elements. */
export function withPackElement<T>(compiler: CompilerBase, element: Syntax, compile: (pattern: Syntax) => T): T {
  const { bindings } = element as PackElement;
  return compiler.withBindings(bindings, () => compile(element.children[0]));
}
