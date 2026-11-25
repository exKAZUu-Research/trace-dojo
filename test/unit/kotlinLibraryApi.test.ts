import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';
import { libraryDeclarationNames, libraryMemberNames } from '../../src/kotlin/libraryApiData';
import { PRELUDE_SOURCES } from '../../src/kotlin/prelude';

// A member the prelude leaves out of a JVM class reads as unavailable only when the generated table lists the class.
// The classes that matter are those the prelude declares under the name of a class of the JDK, whatever their
// visibility; the prelude's own helpers have names the JDK lacks.
test('lists the JVM members of every JVM class the prelude declares', () => {
  const declared = PRELUDE_SOURCES.flatMap((source) => {
    const pkg = /^package ([\w.]+)/m.exec(source)?.[1];
    if (!pkg?.startsWith('java.')) return [];
    const jdkNames = new Set((libraryDeclarationNames[pkg] ?? '').split(' '));
    return [
      ...source.matchAll(
        /^(?:(?:public|internal|open|abstract|data|sealed|final) )*(?:class|interface|object) (\w+)/gm
      ),
    ]
      .map((match) => match[1])
      .filter((name) => jdkNames.has(name))
      .map((name) => `${pkg}.${name}`);
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

test.each([
  ['a qualified constructor call', 'fun main() { println(java.util.TreeMap<Int, Int>()) }'],
  ['an import', 'import java.util.TreeSet\nfun main() { println(TreeSet<Int>()) }'],
  ['a type', 'fun main() { val s: java.util.SortedSet<Int> = sortedSetOf(1); println(s) }'],
  ['a class only the library constructs', 'fun main() { println(java.io.BufferedReader(null)) }'],
])('rejects the direct use of a Java class through %s as unavailable', (_form, source) => {
  const result = executeProgram('kotlin', source);
  expect(result.kind).toBe('compileError');
  expect(JSON.stringify(result)).toContain('この採点環境では使えません');
});
