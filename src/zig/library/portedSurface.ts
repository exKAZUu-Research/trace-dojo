import type { ContainerMember, SourceFile } from '../ast';
import { parseZig } from '../parse';
import { PUBLIC_STD_MEMBERS } from './publicMembers';

/**
 * Gives a library ported from Zig's source every public declaration that the reference declares, adding each one the
 * port leaves out as a declaration that reports, where a program uses it, that this grader does not run it.
 *
 * @param path The library's path below `std`, such as `testing`, by which its containers are listed.
 * @param ownSurface Whether the file's top level is the listed library itself, rather than only holding its types.
 */
export function withPublicSurface(file: SourceFile, path: string, ownSurface = true): SourceFile {
  complete(file.members, path, ownSurface);
  return file;
}

function complete(members: ContainerMember[], path: string, ownSurface: boolean): void {
  for (const member of members) {
    if (member.kind === 'var' && member.isPub && member.value?.kind === 'container')
      complete(member.value.members, `${path}.${member.name}`, true);
  }
  if (!ownSurface || !Object.hasOwn(PUBLIC_STD_MEMBERS, path)) return;
  const declared = new Set(members.map((member) => member.name));
  const missing = PUBLIC_STD_MEMBERS[path].filter((name) => !declared.has(name));
  // A placeholder would hide the outer declaration that the port's own code names.
  const used = identifiersIn(members);
  const shadowed = missing.filter((name) => used.has(name));
  if (shadowed.length > 0)
    throw new Error(`std.${path} uses ${shadowed.join(', ')}, which only the reference declares there`);
  const stubs = missing.map(
    (name) => `pub const @"${name}" = @compileError("std.${path}.${name} は、この採点環境では使えません。");`
  );
  members.push(...parseZig(stubs.join('\n')).members);
}

function identifiersIn(node: unknown, names = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const each of node) identifiersIn(each, names);
  } else if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    if (record.kind === 'identifier' && typeof record.name === 'string') names.add(record.name);
    for (const value of Object.values(record)) identifiersIn(value, names);
  }
  return names;
}
