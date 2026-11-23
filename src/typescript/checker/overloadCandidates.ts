import type { Checker } from './checker';
import type { Sym } from './scopes';
import { parameterNodes } from './signatures';
import { named } from './syntax';
import type { Signature } from './types';

export function prioritizeLiteralOverloads(c: Checker, signatures: Signature[]): Signature[] {
  if (signatures.length < 2) return signatures;
  const specialized: Signature[] = [];
  const ordinary: Signature[] = [];
  const mergedGroups = new Map<Sym, number[]>();
  for (const signature of signatures) {
    if (!hasLiteralParameter(signature)) {
      ordinary.push(signature);
      continue;
    }
    const owner = interfaceOwner(c, signature);
    if (owner) {
      const indices = mergedGroups.get(owner) ?? [];
      indices.push(specialized.length);
      mergedGroups.set(owner, indices);
    }
    specialized.push(signature);
  }
  if (specialized.length === 0) return signatures;
  for (const indices of mergedGroups.values()) {
    // Merged interfaces put later declaration groups first, but TypeScript promotes literal signatures in source order.
    const sourceOrder = indices
      .map((index) => specialized[index])
      .toSorted((a, b) => (a.declaration?.startIndex ?? 0) - (b.declaration?.startIndex ?? 0));
    for (const [offset, index] of indices.entries()) specialized[index] = sourceOrder[offset];
  }
  return [...specialized, ...ordinary];
}

function hasLiteralParameter({ declaration }: Signature): boolean {
  return (
    !!declaration &&
    parameterNodes(declaration).some((parameter) => {
      const annotation = parameter.childForFieldName('type');
      const type = annotation && named(annotation)[0];
      if (type?.type === 'literal_type') return type.text !== 'undefined';
      return type?.type === 'template_literal_type' && !named(type).some((part) => part.type === 'template_type');
    })
  );
}

function interfaceOwner(c: Checker, { declaration }: Signature): Sym | undefined {
  const owner = declaration?.parent?.parent;
  if (owner?.type !== 'interface_declaration') return undefined;
  const name = owner.childForFieldName('name');
  return name ? c.scopeOf(owner).lookupType(name.text) : undefined;
}
