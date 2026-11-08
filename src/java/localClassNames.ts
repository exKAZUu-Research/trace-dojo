import type { ClassDeclaration } from './ast';

/** Gives the next local class a name in a class body, with the smallest number free for its name. */
type Namer = (key: object, suffix: string) => void;

/**
 * The binary names javac gives the local and anonymous classes a class body declares, in source order: the body's
 * class name, `$`, and the smallest number free for each name, as `Main$1`, `Main$2`, and `Main$1L`.
 *
 * @returns The names by the member list of an anonymous class or the declaration of a local class, which identify
 *   them however often they are compiled.
 * @param used The names already given, to which these are added.
 */
export function localClassNamesOf(
  declaration: ClassDeclaration,
  enclosingName: string,
  used: Set<string>
): Map<object, string> {
  const names = new Map<object, string>();
  const name: Namer = (key, suffix) => {
    let number = 1;
    while (used.has(`${enclosingName}$${number}${suffix}`)) number++;
    const binaryName = `${enclosingName}$${number}${suffix}`;
    used.add(binaryName);
    names.set(key, binaryName);
  };
  for (const constant of declaration.enumConstants) {
    visit(constant.args, name);
    if (constant.body) name(constant.body, '');
  }
  for (const member of declaration.members) {
    if (!isClassDeclaration(member.kind)) visit(Object.values(member), name);
  }
  return names;
}

function isClassDeclaration(kind: string | undefined): boolean {
  return kind === 'class' || kind === 'interface' || kind === 'enum';
}

/** Names the local and anonymous classes in `node` in source order, outside member classes and those classes' bodies. */
function visit(node: unknown, name: Namer): void {
  if (Array.isArray(node)) {
    for (const child of node) visit(child, name);
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const { kind } = node as { kind?: string };
  if (isClassDeclaration(kind)) return;
  if (kind === 'localClass') {
    const local = (node as { declaration: ClassDeclaration }).declaration;
    name(local, local.name);
    return;
  }
  const creation = node as { kind?: string; args?: unknown[]; body?: unknown[]; outer?: unknown };
  if (kind === 'new' && creation.body) {
    visit([creation.outer, creation.args], name);
    name(creation.body, '');
    return;
  }
  visit(Object.values(node), name);
}
