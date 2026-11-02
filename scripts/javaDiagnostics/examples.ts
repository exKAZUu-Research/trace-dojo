export interface JavaDiagnosticExample {
  id: string;
  tier: 0 | 1 | 2;
  topic: string;
  source: string;
  expected: 'compiled' | 'compileError';
}

const main = (body: string, members = ''): string => `class Main {
  public static void main(String[] args) {
    ${body}
  }
  ${members}
}`;
const failure = (id: string, tier: 0 | 1 | 2, topic: string, source: string): JavaDiagnosticExample => ({
  id,
  tier,
  topic,
  source,
  expected: 'compileError',
});

export const javaDiagnosticExamples: JavaDiagnosticExample[] = [
  {
    id: 'valid',
    tier: 0,
    topic: 'baseline',
    source: main('Turtle 亀 = new Turtle(); 亀.前に進む();'),
    expected: 'compiled',
  },
  failure('semicolon', 0, 'punctuation', main('int 回数 = 1')),
  failure('for-semicolon', 0, 'loops', main('for (int i = 0 i < 3; i++) {}')),
  failure('parenthesis', 0, 'punctuation', main('if (true {}')),
  failure('bracket', 0, 'arrays', main('int[] 数 = new int[3;')),
  failure('brace', 0, 'punctuation', 'class Main { public static void main(String[] args) {'),
  failure('string', 0, 'literals', main('String 文 = "hello;')),
  failure('character', 0, 'literals', main("char 字 = 'ab';")),
  failure('empty-character', 0, 'literals', main("char 字 = '';")),
  failure('comment', 0, 'comments', main('/* unfinished')),
  failure('fullwidth', 0, 'punctuation', main('int 数 = 1；')),
  failure('escape', 0, 'literals', main(String.raw`String text = "\q";`)),
  failure('identifier', 0, 'declarations', main('int = 1;')),
  failure('expression', 0, 'expressions', main('int 数 = ;')),
  failure('statement', 0, 'expressions', main('1 + 2;')),
  failure('variable', 0, 'names', main('亀.fd(1);')),
  failure('class', 0, 'names', main('かめ 亀 = new かめ();')),
  failure('method', 0, 'calls', main('前に進む();')),
  failure('receiver-method', 0, 'calls', main('Turtle 亀 = new Turtle(); 亀.前進する();')),
  failure('scope', 1, 'loops', main('for (int 回数 = 0; 回数 < 3; 回数++) {}\n    System.out.println(回数);')),
  failure('duplicate-variable', 1, 'declarations', main('int 回数 = 1; int 回数 = 2;')),
  failure(
    'duplicate-method',
    1,
    'overloading',
    main('', 'static void 進む(int 数) {}\n  static void 進む(int 別名) {}')
  ),
  failure('duplicate-class', 1, 'classes', `${main('')}\nclass 亀 {}\nclass 亀 {}`),
  failure('boolean-value', 0, 'values', main('int 数 = true;')),
  failure('condition', 0, 'conditions', main('while (1) {}')),
  failure('string-value', 0, 'values', main('int 数 = "hello";')),
  failure('narrowing', 1, 'values', main('int 数 = 1.5;')),
  failure('binary-operator', 1, 'operators', main('int 数 = true + 1;')),
  failure('unary-operator', 1, 'operators', main('int 数 = 1; boolean 判定 = !数;')),
  failure('incomparable', 1, 'operators', main('boolean 判定 = 1 == true;')),
  failure('dereference', 1, 'values', main('int 数 = 1; 数.fd(1);')),
  failure('final-assignment', 2, 'values', main('final int 数 = 1; 数 = 2;')),
  failure('assignment-target', 1, 'values', main('1 = 2;')),
  failure('arguments', 0, 'calls', main('進む();', 'static void 進む(int 数) {}')),
  failure('argument-type', 0, 'calls', main('進む(true);', 'static void 進む(int 数) {}')),
  failure('constructor', 1, 'objects', main('Turtle 亀 = new Turtle(true);')),
  failure('return-path', 1, 'returns', main('', 'static int 数(boolean 判定) { if (判定) return 1; }')),
  failure('return-empty', 1, 'returns', main('', 'static int 数() { return; }')),
  failure('return-value', 1, 'returns', main('return 1;')),
  failure('static-method', 2, 'static', main('進む();', 'void 進む() {}')),
  failure('static-field', 2, 'static', main('System.out.println(回数);', 'int 回数 = 1;')),
  failure(
    'private-access',
    2,
    'encapsulation',
    `${main('亀 相手 = new 亀(); System.out.println(相手.速さ);')}\nclass 亀 { private int 速さ = 1; }`
  ),
  failure('missing-main', 0, 'entry', 'class Main {}'),
  failure('nonstatic-main', 2, 'entry', 'class Main { public void main(String[] args) {} }'),
  failure('uninitialized', 1, 'values', main('int 回数; if (args.length > 0) 回数 = 1; System.out.println(回数);')),
  failure('unreachable', 1, 'flow', main('return; System.out.println(1);')),
  failure('else', 1, 'conditions', main('if (true) {}; else {}')),
  failure('break', 1, 'flow', main('break;')),
  failure('continue', 1, 'flow', main('continue;')),
  failure('not-array', 1, 'arrays', main('int 数 = 1; System.out.println(数[0]);')),
  failure('array-dimension', 1, 'arrays', main('int[] 数 = new int[];')),
  failure('array-index', 1, 'arrays', main('int[] 数 = {1}; System.out.println(数[true]);')),
  failure('foreach', 1, 'arrays', main('for (int 数 : 1) {}')),
  failure('switch-case', 1, 'switch', main('switch (1) { case 1: break; case 1: break; }')),
  failure('switch-default', 1, 'switch', main('switch (1) { default: break; default: break; }')),
  failure('try', 2, 'exceptions', main('try {}')),
  failure('catch', 2, 'exceptions', main('catch (Exception e) {}')),
  failure('checked-exception', 2, 'exceptions', main('throw new Exception();')),
  failure(
    'override-return',
    2,
    'inheritance',
    `${main('')}\nclass 親 { int 数() { return 1; } }\nclass 子 extends 親 { String 数() { return "a"; } }`
  ),
];
