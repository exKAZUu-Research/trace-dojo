import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';
import { libraryMemberNames } from '../../src/kotlin/libraryApiData';
import { PRELUDE_SOURCES } from '../../src/kotlin/prelude';

// A member the prelude leaves out of a JVM class reads as unavailable only when the generated table lists the class.
test('lists the JVM members of every JVM class the prelude declares', () => {
  const declared = PRELUDE_SOURCES.flatMap((source) => {
    const pkg = /^package ([\w.]+)/m.exec(source)?.[1];
    if (!pkg?.startsWith('java.')) return [];
    return [
      ...source.matchAll(
        /^(?:(?:public|open|abstract|data|sealed|final|internal) )*(?:class|interface|object) (\w+)/gm
      ),
    ].map((match) => `${pkg}.${match[1]}`);
  });
  expect(declared).toContain('java.util.TreeSet');
  expect(declared.filter((name) => !Object.hasOwn(libraryMemberNames, name))).toEqual([]);
});

test('rejects as unavailable the JVM members the prelude leaves out', () => {
  const source = `fun main() {
    val t = sortedSetOf(1, 2)
    println(t.spliterator())
}`;
  const result = executeProgram('kotlin', source);
  expect(result.kind).toBe('compileError');
  expect(JSON.stringify(result)).toContain('この採点環境では使えません');
});
