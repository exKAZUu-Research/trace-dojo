import { expect, test } from 'vitest';

import { collectJavaCandidates } from '../../src/problems/generation/languages/java/collectCandidates';
import { generateJavaExercise } from '../../src/problems/generation/languages/java/generate';
import type { Selector } from '../../src/problems/generation/types';
import { gradeFillInBlankCode } from '../../src/problems/grading/turtleState';

const wrap = (body: string): string => `class Main { public static void main(String[] args) { ${body} } }`;
const source = wrap('Turtle 亀 = new Turtle(); for (int i = 0; i < 3; i++) { 亀.前に進む(); }');

// These assertions exercise source spans exposed by the authoring API, not parser-node implementation details.
test('overlapping selectors do not multiply ranges or change seeded selection', () => {
  const selectors: Selector[] = ['for', 'variableDeclaration', 'operator'];
  const candidates = collectJavaCandidates(source, selectors);
  const ranges = candidates.map(({ start, end }) => `${start}:${end}`);
  expect(new Set(ranges).size).toBe(ranges.length);
  expect(candidates.filter(({ start, end }) => source.slice(start, end) === 'int i = 0')).toHaveLength(1);
  expect(candidates.some(({ start, end }) => source.slice(start, end) === 'i < 3')).toBe(true);
  expect(candidates.some(({ start, end }) => source.slice(start, end) === '<')).toBe(true);
  for (let seed = 0; seed < 20; seed++) {
    const input = { source, format: 'fillInBlank' as const, seed: String(seed) };
    expect(generateJavaExercise({ ...input, selectors })).toEqual(
      generateJavaExercise({ ...input, selectors: [...selectors, 'operator', 'for'] })
    );
  }
});

test('source offsets preserve Japanese, supplementary characters, CRLF and literal punctuation', () => {
  const text = wrap('String s = "😀 // atomic"; Turtle 亀 = new Turtle();\r\n亀.前に進む();');
  const candidates = collectJavaCandidates(text, ['call', 'literal']);
  const snippets = candidates.map(({ start, end }) => text.slice(start, end));
  expect(snippets).toContain('"😀 // atomic"');
  expect(snippets).toContain('前に進む');
  expect(snippets).toContain('亀.前に進む()');
  expect(snippets).not.toContain('亀.前に進む();');
});

test('control selection exposes headers and keywords without selecting bodies or nested unselected constructs', () => {
  const text = wrap('for (int i = 0; i < 2; i++) { if (i == 1) { new Turtle().forward(); } }');
  const snippets = collectJavaCandidates(text, ['for']).map(({ start, end }) => text.slice(start, end));
  expect(snippets).toContain('for');
  expect(snippets).toContain('int i = 0');
  expect(snippets).toContain('i < 2');
  expect(snippets).toContain('i++');
  expect(snippets).not.toContain('if');
  expect(snippets).not.toContain('i == 1');
  expect(snippets.every((snippet) => !snippet.includes('{'))).toBe(true);
});

test('keywords and declared types are usable holes and leave outer delimiters intact', () => {
  const text = wrap(
    'int n = 1; Turtle t = new Turtle(); if (n > 0) t.forward(); else t.backward(); switch(n) { case 1: break; default: break; }'
  );
  const snippets = collectJavaCandidates(text, ['variableDeclaration', 'construction', 'if', 'switch', 'operator']).map(
    ({ start, end }) => text.slice(start, end)
  );
  for (const token of ['int', 'Turtle', 'new', 'if', 'else', 'switch', 'case', 'default'])
    expect(snippets).toContain(token);
  expect(snippets).not.toContain('=');
  expect(snippets).not.toContain('(n > 0)');
  expect(snippets).not.toContain('case 1:');
});

test('arguments use individual and comma-separated spans, and references exclude declarations and method names', () => {
  const text = 'class Main { static void run(int a, int b) { run(a, b); } }';
  const calls = collectJavaCandidates(text, ['call']).map(({ start, end }) => text.slice(start, end));
  expect(calls).toContain('a, b');
  expect(calls).not.toContain('(a, b)');
  const references = collectJavaCandidates(text, ['variableReference']);
  expect(references).toHaveLength(2);
  expect(references.map(({ start, end }) => text.slice(start, end))).toEqual(['a', 'b']);
});

test('every produced hole restores the canonical source exactly, including multiline spans', () => {
  const text = wrap('Turtle t = new Turtle();\r\nint[] ns = {\r\n1, 2\r\n};\r\nt.forward(); // atomic\r\n');
  let multiline = false;
  for (let seed = 0; seed < 40; seed++) {
    const result = generateJavaExercise({
      source: text,
      selectors: ['array', 'call'],
      format: 'fillInBlank',
      seed: String(seed),
    });
    expect(result).toBeDefined();
    if (!result) throw new Error('Expected a generated exercise');
    multiline ||= result.answer!.includes('\n');
    expect(result.displayProgram.replace('【1】', result.answer!)).toBe(result.correctProgram);
    expect(result.correctProgram).toContain('int[] ns = {\r\n1, 2\r\n};');
    expect(result.correctProgram).not.toContain('// atomic');
    expect(gradeFillInBlankCode(result, result.correctProgram)).toEqual({ status: 'correct' });
  }
  expect(multiline).toBe(true);
});

test('range selection is approximately uniform and duplicate rules cannot weight the sample', () => {
  const text = wrap('Turtle t = new Turtle(1, 1); t.forward();');
  const counts = new Map<number, number>();
  for (let seed = 0; seed < 400; seed++) {
    const result = generateJavaExercise({
      source: text,
      selectors: ['literal', 'literal'],
      format: 'fillInBlank',
      seed: String(seed),
    });
    if (!result) throw new Error('Missing literal hole');
    counts.set(result.range.start, (counts.get(result.range.start) ?? 0) + 1);
  }
  expect(counts.size).toBe(2);
  for (const count of counts.values()) expect(count).toBeGreaterThan(140);
});

test('generation fails closed for empty policies, unavailable candidates and unsuccessful baselines', () => {
  expect(generateJavaExercise({ source, selectors: [], format: 'fillInBlank', seed: 'empty' })).toBeUndefined();
  expect(generateJavaExercise({ source, selectors: ['throw'], format: 'bugFix', seed: 'missing' })).toBeUndefined();
  expect(
    generateJavaExercise({
      source: wrap('throw new RuntimeException();'),
      selectors: ['throw'],
      format: 'fillInBlank',
      seed: 'exception',
    })
  ).toBeUndefined();
  expect(
    generateJavaExercise({
      source: source + ' '.repeat(20_001),
      selectors: ['literal'],
      format: 'fillInBlank',
      seed: 'large',
    })
  ).toBeUndefined();
});

test.each(['logical', 'syntax'] as const)('%s mutants fail grading while their original source passes', (bugKind) => {
  for (let seed = 0; seed < 12; seed++) {
    const result = generateJavaExercise({
      source,
      selectors: ['for', 'operator', 'call', 'literal'],
      format: 'bugFix',
      bugKind,
      seed: String(seed),
    });
    expect(result).toBeDefined();
    if (!result) throw new Error('Missing mutant');
    expect(gradeFillInBlankCode(result, result.correctProgram)).toEqual({ status: 'correct' });
    expect(gradeFillInBlankCode(result, result.displayProgram)).toMatchObject({
      status: 'incorrect',
      detail: bugKind === 'logical' ? 'The final state differs from the expected one.' : 'Compile error.',
    });
    expect(result.bugKind).toBe(bugKind);
  }
});

const mechanisms: { name: string; source: string; selectors: Selector[]; matches: RegExp }[] = [
  {
    name: 'shared state',
    source:
      wrap('A a = new A(); A b = new A(); a.n = 2; for(int i=0;i<b.n;i++) b.t.forward();') +
      ' class A { static int n = 1; Turtle t = new Turtle(); }',
    selectors: ['modifier'],
    matches: /class A \{\s+int n/,
  },
  {
    name: 'dynamic dispatch',
    source:
      wrap('A a = new B(); a.go();') +
      ' class A { Turtle t = new Turtle(); void go(){ t.forward(); } } class B extends A { void go(){ t.forward(); t.forward(); } }',
    selectors: ['construction'],
    matches: /A a = new A\(/,
  },
  {
    name: 'overload selection',
    source:
      'class Main { static Turtle t = new Turtle(); public static void main(String[] args){ go(2); } static void go(){ t.forward(); } static void go(int n){ for(int i=0;i<n;i++) t.forward(); } }',
    selectors: ['call'],
    matches: /main\(String\[\] args\)\{ go\(\);/,
  },
  {
    name: 'caught exception propagation',
    source: wrap(
      'Turtle t = new Turtle(); try { go(t); t.forward(); } catch (RuntimeException e) { t.turnRight(); }'
    ).replace(/ } }$/, ' } static void go(Turtle t){ t.forward(); throw new RuntimeException(); } }'),
    selectors: ['throw'],
    matches: /return;/,
  },
];

test.each(mechanisms)('can generate a repair exercise for $name', ({ source: text, selectors, matches }) => {
  expect(matches.test(text)).toBe(false);
  let found = false;
  for (let seed = 0; seed < 40 && !found; seed++) {
    const result = generateJavaExercise({
      source: text,
      selectors,
      format: 'bugFix',
      bugKind: 'logical',
      seed: String(seed),
    });
    if (!result) continue;
    expect(gradeFillInBlankCode(result, result.correctProgram)).toEqual({ status: 'correct' });
    expect(gradeFillInBlankCode(result, result.displayProgram)).toEqual({
      status: 'incorrect',
      detail: 'The final state differs from the expected one.',
    });
    found = matches.test(result.displayProgram);
  }
  expect(found).toBe(true);
});

test.each([
  {
    name: 'reference alias',
    body: 'Turtle a = new Turtle(); Turtle b = new Turtle(2, 2); Turtle alias = a; alias.forward();',
    selectors: ['variableDeclaration'] as Selector[],
    changed: 'Turtle alias = b',
  },
  {
    name: 'argument order',
    body: 'Turtle t = new Turtle(1, 2); t.forward();',
    selectors: ['construction'] as Selector[],
    changed: 'new Turtle(2, 1)',
  },
  {
    name: 'array index order',
    body: 'int[][] ns = {{1, 2}, {3, 1}}; Turtle t = new Turtle(); for(int i=0;i<ns[0][1];i++) t.forward();',
    selectors: ['array'] as Selector[],
    changed: 'ns[1][0]',
  },
])('preserves $name as an observable mutation mechanism', ({ body, selectors, changed }) => {
  let found = false;
  for (let seed = 0; seed < 80 && !found; seed++) {
    const result = generateJavaExercise({
      source: wrap(body),
      selectors,
      format: 'bugFix',
      bugKind: 'logical',
      seed: String(seed),
    });
    if (!result) continue;
    if (result.displayProgram.includes(changed)) {
      expect(gradeFillInBlankCode(result, result.correctProgram).status).toBe('correct');
      expect(gradeFillInBlankCode(result, result.displayProgram)).toEqual({
        status: 'incorrect',
        detail: 'The final state differs from the expected one.',
      });
      found = true;
    }
  }
  expect(found).toBe(true);
});

test('logical mutation selection does not weight a range by its number of valid replacements', () => {
  const text = wrap('Turtle t = new Turtle(0, 2); t.forward();');
  const counts = new Map<number, number>();
  for (let seed = 0; seed < 240; seed++) {
    const result = generateJavaExercise({
      source: text,
      selectors: ['literal'],
      format: 'bugFix',
      bugKind: 'logical',
      seed: String(seed),
    });
    if (!result) throw new Error('Missing coordinate mutation');
    expect(result).toEqual(
      generateJavaExercise({
        source: text,
        selectors: ['literal', 'literal'],
        format: 'bugFix',
        bugKind: 'logical',
        seed: String(seed),
      })
    );
    counts.set(result.range.start, (counts.get(result.range.start) ?? 0) + 1);
  }
  expect(counts.size).toBe(2);
  for (const count of counts.values()) expect(count).toBeGreaterThan(80);
});

test('array initializers and nested accesses remain repairable source ranges', () => {
  const text = wrap('int[][] ns = {{1, 2}, {3, 1}}; Turtle t = new Turtle(ns[0][1], 0);');
  const snippets = collectJavaCandidates(text, ['array']).map(({ start, end }) => text.slice(start, end));
  expect(snippets).toContain('{{1, 2}, {3, 1}}');
  expect(snippets).toContain('ns[0][1]');
  expect(snippets).toContain('ns[0]');
  expect(snippets).not.toContain('[0][1]');
});

test('DFS reaches enabled calls inside disabled loops and branches', () => {
  const text = wrap('for(int i=0;i<2;i++){ if(i==1){ new Turtle().forward(); } }');
  const snippets = collectJavaCandidates(text, ['call']).map(({ start, end }) => text.slice(start, end));
  expect(snippets).toContain('new Turtle().forward()');
  expect(snippets).not.toContain('for');
  expect(snippets).not.toContain('if');
});

test.each([
  {
    name: 'field shadowing',
    source:
      wrap('A a = new A(2); a.go();') +
      ' class A { int n; Turtle t = new Turtle(); A(int n){ this.n = n; } void go(){ for(int i=0;i<n;i++) t.forward(); } }',
    selectors: ['member'] as Selector[],
    changed: ' n = n;',
  },
  {
    name: 'predicate pruning',
    source: wrap('Turtle t = new Turtle(); int n = -1; if(n >= 0 && n <= 2) t.forward();'),
    selectors: ['if'] as Selector[],
    changed: 'if(n <= 2)',
  },
])('generates a logical $name repair', ({ source: text, selectors, changed }) => {
  expect(text).not.toContain(changed);
  let found = false;
  for (let seed = 0; seed < 80 && !found; seed++) {
    const result = generateJavaExercise({
      source: text,
      selectors,
      format: 'bugFix',
      bugKind: 'logical',
      seed: String(seed),
    });
    if (!result?.displayProgram.includes(changed)) continue;
    expect(gradeFillInBlankCode(result, result.displayProgram)).toEqual({
      status: 'incorrect',
      detail: 'The final state differs from the expected one.',
    });
    expect(gradeFillInBlankCode(result, result.correctProgram)).toEqual({ status: 'correct' });
    found = true;
  }
  expect(found).toBe(true);
});

test('candidate limits reject an otherwise executable source instead of sampling its prefix', () => {
  const text = wrap(`int n = 0; ${'n++;'.repeat(1100)} new Turtle().forward();`);
  expect(
    generateJavaExercise({ source: text, selectors: ['assignment'], format: 'fillInBlank', seed: 'bounded' })
  ).toBeUndefined();
});

test('argument expression parentheses are intrinsic, unlike control header delimiters', () => {
  const text = 'class Main { void f(int a) { f((a + 1)); if ((a > 0)) f(a); } }';
  const snippets = collectJavaCandidates(text, ['call', 'if']).map(({ start, end }) => text.slice(start, end));
  expect(snippets).toContain('(a + 1)');
  expect(snippets).not.toContain('a + 1');
  expect(snippets).toContain('(a > 0)');
  expect(snippets).not.toContain('((a > 0))');
});

test('references in ternaries remain selectable while declared names do not', () => {
  const text = 'class Main { void f(boolean c, int a, int b){ int n = c ? a : b; } }';
  expect(collectJavaCandidates(text, ['variableReference']).map(({ start, end }) => text.slice(start, end))).toEqual([
    'c',
    'a',
    'b',
  ]);
});

test('for headers retain comma-separated initializers and updates as complete parts', () => {
  const text = wrap('for(int i=0,j=0;i<2;i++,j++){ new Turtle().forward(); }');
  const snippets = collectJavaCandidates(text, ['for']).map(({ start, end }) => text.slice(start, end));
  expect(snippets).toContain('int i=0,j=0');
  expect(snippets).toContain('i++,j++');
  expect(snippets).not.toContain('i++');
});

test('oversized argument permutation sets abort generation before enumerating them', () => {
  const parameters = Array.from({ length: 30 }, (_, i) => `int a${i}`).join(',');
  const arguments_ = Array.from({ length: 30 }, () => '1').join(',');
  const text = `class Main { public static void main(String[] args){ f(${arguments_}); } static void f(${parameters}){ new Turtle().forward(); } }`;
  expect(
    generateJavaExercise({ source: text, selectors: ['call'], format: 'bugFix', seed: 'bounded' })
  ).toBeUndefined();
});

test('enhanced-for iterable is a use while its bound variable is a declaration', () => {
  const text = 'class Main { void f(int[] ns){ for(int n : ns){} } }';
  expect(collectJavaCandidates(text, ['variableReference']).map(({ start, end }) => text.slice(start, end))).toEqual([
    'ns',
  ]);
});

test('mutation alternatives never inject placeholder identifiers into real source', () => {
  const text = `class Main {
    public static void main(String[] args) {
      Turtle t = new Turtle(1, 2);
      int n = 1;
      if (n > 0) t.forward();
      Main.move(t, n);
    }
    static void move(Turtle t, int n) {
      for (int i = 0; i < n; i++) { t.forward(); }
      if (n == 0) throw new RuntimeException("zero");
      return;
    }
  }`;
  const candidates = collectJavaCandidates(text, [
    'modifier',
    'construction',
    'literal',
    'variableDeclaration',
    'variableReference',
    'if',
    'for',
    'operator',
    'call',
    'throw',
    'return',
  ]);
  expect(candidates.length).toBeGreaterThan(0);
  for (const candidate of candidates)
    for (const replacement of candidate.replacements) expect(replacement).not.toContain('__invalid__');
});

test('a keyword without meaningful mutations remains a hole but cannot force a bug', () => {
  const text = wrap('for (;;) { break; }');
  const input = { source: text, selectors: ['for'] as Selector[], seed: 'keyword-only' };
  const blank = generateJavaExercise({ ...input, format: 'fillInBlank' });
  expect(blank?.answer).toBe('for');
  expect(generateJavaExercise({ ...input, format: 'bugFix' })).toBeUndefined();
});

test.each([
  { original: '&&', changed: '||' },
  { original: '||', changed: '&&' },
])('swapping $original produces an executable logical bug', ({ original, changed }) => {
  const text = wrap(`Turtle t = new Turtle(); if (true ${original} false) t.forward();`);
  const result = generateJavaExercise({
    source: text,
    selectors: ['operator'],
    format: 'bugFix',
    seed: 'boolean-swap',
  });
  expect(result).toBeDefined();
  if (!result) throw new Error('Missing logical mutant');
  expect(result.displayProgram).toBe(text.replace(original, changed));
  expect(result.bugKind).toBe('logical');
  expect(gradeFillInBlankCode(result, result.displayProgram)).toMatchObject({
    status: 'incorrect',
    detail: 'The final state differs from the expected one.',
  });
  expect(gradeFillInBlankCode(result, text)).toEqual({ status: 'correct' });
});
