import { expect, test } from 'vitest';

import { collectJavaCandidates } from '../../src/problems/generation/languages/java/collectCandidates';
import { generateJavaExercise } from '../../src/problems/generation/languages/java/generate';
import type { Selector } from '../../src/problems/generation/types';
import { gradeFillInBlankCode } from '../../src/problems/grading/turtleState';

const wrap = (body: string): string => `class Main { public static void main(String[] args) { ${body} } }`;
const source = wrap('Turtle 亀 = new Turtle(); for (int i = 0; i < 3; i++) { 亀.前に進む(); }');

// These assertions exercise source spans exposed by the authoring API, not parser-node implementation details.
test('overlapping selectors do not multiply ranges or change seeded selection', () => {
  const selectors: Selector[] = [
    'for',
    'variableDeclaration',
    'comparisonOperator',
    'arithmeticOperator',
    'logicalOperator',
    'assignmentOperator',
    'updateOperator',
  ];
  const candidates = collectJavaCandidates(source, selectors);
  const ranges = candidates.map(({ start, end }) => `${start}:${end}`);
  expect(new Set(ranges).size).toBe(ranges.length);
  expect(candidates.filter(({ start, end }) => source.slice(start, end) === 'int i = 0')).toHaveLength(1);
  expect(candidates.some(({ start, end }) => source.slice(start, end) === 'i < 3')).toBe(true);
  expect(candidates.some(({ start, end }) => source.slice(start, end) === '<')).toBe(true);
  for (let seed = 0; seed < 20; seed++) {
    const input = { source, format: 'fillInBlank' as const, seed: String(seed) };
    expect(generateJavaExercise({ ...input, selectors })).toEqual(
      generateJavaExercise({
        ...input,
        selectors: [
          ...selectors,
          'comparisonOperator',
          'arithmeticOperator',
          'logicalOperator',
          'assignmentOperator',
          'updateOperator',
          'for',
        ],
      })
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
  const snippets = collectJavaCandidates(text, [
    'variableDeclaration',
    'construction',
    'if',
    'switch',
    'comparisonOperator',
    'arithmeticOperator',
    'logicalOperator',
    'assignmentOperator',
    'updateOperator',
  ]).map(({ start, end }) => text.slice(start, end));
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
  expect(
    generateJavaExercise({ source, selectors: ['throw', 'return'], format: 'bugFix', seed: 'missing' })
  ).toBeUndefined();
  expect(
    generateJavaExercise({
      source: wrap('throw new RuntimeException();'),
      selectors: ['throw', 'return'],
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
      source: source.replace('new Turtle()', 'new Turtle(1, 2)'),
      selectors: [
        'construction',
        'for',
        'comparisonOperator',
        'arithmeticOperator',
        'logicalOperator',
        'assignmentOperator',
        'updateOperator',
        'call',
        'literal',
      ],
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
    selectors: ['throw', 'return'],
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
    selectors: ['variableDeclaration', 'variableReference'] as Selector[],
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
    selectors: ['member', 'variableReference'] as Selector[],
    changed: ' n = n;',
  },
  {
    name: 'predicate pruning',
    source: wrap('Turtle t = new Turtle(); int n = -1; if(n >= 0 && n <= 2) t.forward();'),
    selectors: ['if', 'logicalOperator', 'comparisonOperator'] as Selector[],
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
    'comparisonOperator',
    'arithmeticOperator',
    'logicalOperator',
    'assignmentOperator',
    'updateOperator',
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
    selectors: ['logicalOperator'],
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

test('arithmetic selection excludes comparison and logical tokens in nested conditions', () => {
  const text = wrap('int a = 1; if (a + 1 > 0 && a < 3) new Turtle().forward();');
  const candidates = collectJavaCandidates(text, ['arithmeticOperator']);
  expect(candidates.map((c) => text.slice(c.start, c.end))).toEqual(['+']);
  for (let seed = 0; seed < 8; seed++) {
    const blank = generateJavaExercise({
      source: text,
      selectors: ['arithmeticOperator'],
      format: 'fillInBlank',
      seed: String(seed),
    });
    expect(blank?.displayProgram).toContain('a 【1】 1 > 0 && a < 3');
  }
});

test('whole conditions cannot bypass unlearned logical operators', () => {
  const text = wrap('Turtle t = new Turtle(); if (true && false) t.forward();');
  expect(
    generateJavaExercise({ source: text, selectors: ['if', 'arithmeticOperator'], format: 'bugFix', seed: 'guard' })
  ).toBeUndefined();
  const candidates = collectJavaCandidates(text, ['if', 'logicalOperator']);
  expect(candidates.find((c) => text.slice(c.start, c.end) === 'true && false')?.replacements).toContain('true');
});

test('reference mistakes respect nearest declarations, dimensions, and static context', () => {
  const text = `class Main { int instance = 1; static int hidden = 2;
    public static void main(String[] args) {
      int a = 1; int b = 2; int[] ns = {1}; int other[] = {2}; boolean hidden = true; { int closed = 3; }
      int n = a; int later = 4; new Turtle(n, 0).forward();
    }
  }`;
  const candidates = collectJavaCandidates(text, ['variableReference']);
  const at = text.indexOf('= a;') + 2;
  const replacements = candidates.find((c) => c.start === at)?.replacements;
  expect(replacements).toContain('b');
  expect(replacements).not.toContain('hidden');
  expect(replacements).not.toContain('instance');
  expect(replacements).not.toContain('ns');
  for (const excluded of ['true', 'false', '0', '1', 'n', 'later', 'closed', 'other'])
    expect(replacements).not.toContain(excluded);
});

test('numeric edits distinguish signs, concatenation, and nondecimal literals', () => {
  const text = wrap('int n = 2; int v = -n; String s = "a" + "b"; long big = 9007199254740993L; int hex = 0x10;');
  const candidates = collectJavaCandidates(text, ['arithmeticOperator', 'literal']);
  const sign = candidates.find((c) => text.slice(c.start, c.end) === '-');
  expect(sign?.replacements).toEqual(['+']);
  for (const spelling of ['+', '9007199254740993L', '0x10'])
    expect(candidates.find((c) => text.slice(c.start, c.end) === spelling)?.replacements).toEqual([]);
});

test('numeric declaration type confusion produces a repairable truncation error', () => {
  const text = wrap('double n = 3; double fraction = n / 2; Turtle t = new Turtle(); if (fraction > 1) t.forward();');
  const candidates = collectJavaCandidates(text, ['variableDeclaration', 'arithmeticOperator']);
  expect(candidates.find((c) => text.slice(c.start, c.end) === 'double')?.replacements).toContain('int');
  expect(candidates.flatMap((c) => c.replacements)).not.toContain('boolean');
  const generated = generateJavaExercise({
    source: text,
    selectors: ['variableDeclaration', 'arithmeticOperator'],
    format: 'bugFix',
    seed: 'numeric-type',
  });
  expect(generated).toBeDefined();
  if (!generated) throw new Error('Missing numeric mutation');
  expect(gradeFillInBlankCode(generated, text.replace('double n', 'int n'))).toMatchObject({
    status: 'incorrect',
    detail: 'The final state differs from the expected one.',
  });
  expect(gradeFillInBlankCode(generated, text)).toEqual({ status: 'correct' });
});

test('jump swaps respect switch targets and both learned jump constructs', () => {
  const text = wrap('for(int i=0;i<2;i++){ switch(i){ case 0: break; default: break; } continue; }');
  const onlyBreak = collectJavaCandidates(text, ['break']);
  expect(onlyBreak).toHaveLength(2);
  expect(onlyBreak.every((c) => c.replacements.length === 0)).toBe(true);
  const both = collectJavaCandidates(text, ['break', 'continue']);
  expect(collectJavaCandidates(wrap('for(;;){break;}'), ['break'])[0]?.replacements).toEqual([]);
  expect(both).toHaveLength(3);
  expect(both.filter((c) => text.slice(c.start, c.end) === 'break').every((c) => c.replacements.length === 0)).toBe(
    true
  );
  expect(both.find((c) => text.slice(c.start, c.end) === 'continue')?.replacements).toContain('break');
});

test('semantic mutation prerequisites apply even when a different selector owns the range', () => {
  const text = wrap('int a=1; int b=2; int n=a;');
  const candidates = collectJavaCandidates(text, ['variableDeclaration']);
  expect(candidates.find((c) => text.slice(c.start, c.end) === 'a')?.replacements).toEqual([]);
  const shadow = wrap('A a=new A();') + ' class A { int x; A(int x){ this.x=x; } }';
  expect(
    collectJavaCandidates(shadow, ['member']).find((c) => shadow.slice(c.start, c.end) === 'this.x')?.replacements
  ).not.toContain('x');
  const throwing = wrap('throw new RuntimeException();');
  expect(
    collectJavaCandidates(throwing, ['throw']).find((c) => throwing.slice(c.start, c.end).startsWith('throw '))
      ?.replacements
  ).toEqual([]);
});

test('construction mistakes use related classes rather than arbitrary declarations', () => {
  const text = wrap('A a=new B();') + ' class A {} class B extends A {} class Unrelated {}';
  const candidates = collectJavaCandidates(text, ['construction']);
  const type = candidates.find((c) => text.slice(c.start, c.end) === 'B');
  expect(type?.replacements).toContain('A');
  expect(type?.replacements).not.toContain('Unrelated');
  expect(type?.replacements).not.toContain('int');
});

test.each([
  {
    source: 'class Main { Turtle n; Turtle t; void f(int[] ns){ for(int n : ns){ int x = n; } } }',
    reference: '= n;',
    forbidden: 't',
  },
  {
    source: 'class Main { int e; int x; void f(){ try {} catch(RuntimeException e){ throw e; } } }',
    reference: 'throw e;',
    forbidden: 'x',
  },
])(
  'unsupported binding scopes cannot fall back to an outer type: $reference',
  ({ source: text, reference, forbidden }) => {
    const start = text.indexOf(reference) + reference.indexOf(reference === '= n;' ? 'n' : 'e');
    const candidate = collectJavaCandidates(text, ['variableReference']).find((c) => c.start === start);
    expect(candidate).toBeDefined();
    expect(candidate?.replacements).not.toContain(forbidden);
  }
);

test('a member name is not a same-spelled local reference', () => {
  const text = 'class Main { int n; void f(){ Turtle n = new Turtle(); Turtle t = new Turtle(); this.n = 1; } }';
  const candidate = collectJavaCandidates(text, ['member', 'variableReference']).find(
    (c) => c.start === text.indexOf('this.n') + 5
  );
  expect(candidate).toBeDefined();
  expect(candidate?.replacements).toEqual([]);
});
