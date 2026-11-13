import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { executeProgram, type ProgramExecution } from '../../src/interpreter/program';

// The interpreter's clock stands still in these tests, so that the program, not the load of the host, decides each one.
beforeEach(() => {
  vi.spyOn(performance, 'now').mockReturnValue(0);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const run = (program: string): ProgramExecution => executeProgram('ruby', program);

// Ruby 4.0.9 rejects each of these before running.
test.each([
  ['break outside a loop', 'puts 1\nbreak'],
  ['next outside a loop', 'next'],
  ['retry outside rescue', 'retry'],
  ['yield outside a method', 'yield'],
  ['return in a class body', 'class Foo\n  return 1\nend'],
  ['a constant assigned in a method', 'def m\n  X = 1\nend'],
  ['a class defined in a method', 'def m\n  class A; end\nend'],
  ['a repeated parameter name', 'def m(a, a); end'],
  ['two rest parameters', 'def foo(*a, *b); end'],
  ['an assignment to self', 'self = 1'],
  ['an incomplete expression', 'x = 1 +'],
  ['a value that leaves the expression', 'x = return 1'],
  ['a block and a block argument together', 'foo(&b) { }'],
  ['else without rescue', 'begin\n  1\nelse\n  2\nend'],
  ['a lowercase class name', 'class foo; end'],
  ['a command call as an operand', 'p 1 && p 2'],
])('%s is a compile error', (_name, program) => {
  expect(run(program).kind).toBe('compileError');
});

test.each([
  ['a regular expression', 'p "a" =~ /a/', '正規表現'],
  ['pattern matching', 'case [1]\nin [x]\nend', 'パターンマッチ'],
  ['a heredoc', 'x = <<~EOS\n  a\nEOS', 'ヒアドキュメント'],
  ['a singleton class', 'class << self\nend', '特異クラス'],
  ['a numbered block parameter', '[1].each { p _1 }', '番号指定パラメータ'],
])('%s is refused before running in this stage', (_name, program, feature) => {
  const execution = run(program);
  expect(execution.kind).toBe('compileError');
  if (execution.kind === 'compileError') {
    expect(execution.diagnostics[0].message).toContain(feature);
    expect(execution.diagnostics[0].message).toContain('は、この採点環境では使えません。');
  }
});

test.each([
  ['standard input', 'x = gets', '標準入力（gets）は、この採点環境では使えません。'],
  ['a file', 'File.read("a.txt")', 'ファイルの読み書き（File）は、この採点環境では使えません。'],
  ['require', 'require "json"', 'require（ライブラリ・別のファイルの読み込み）は、この採点環境では使えません。'],
  ['a thread', 'Thread.new { }', 'スレッド（Thread）は、この採点環境では使えません。'],
  ['eval', 'eval("1")', '文字列の評価（eval）は、この採点環境では使えません。'],
  ['send', '1.send(:+, 2)', 'send（名前によるメソッドの呼び出し）は、この採点環境では使えません。'],
])('%s stops the program with the unsupported-feature message, which rescue cannot catch', (_name, program, message) => {
  const execution = run(`puts "before"\nbegin\n  ${program}\nrescue Exception\n  puts "rescued"\nend`);
  expect(execution).toMatchObject({ kind: 'executed', stdout: 'before\n', uncaughtException: message });
});

test('a class Ruby defines as a module cannot be defined as a class', () => {
  expect(run('class Signal\nend')).toMatchObject({ uncaughtException: 'Signal is not a class (TypeError)' });
});

test('an endless loop exceeds the operation limit, and endless recursion raises SystemStackError', () => {
  expect(run('loop do\nend')).toEqual({ kind: 'limitExceeded', limit: 'operations' });
  expect(run('def f(n) = f(n + 1)\nf(0)')).toMatchObject({
    uncaughtException: 'stack level too deep (SystemStackError)',
  });
});

test('standard error is accepted but not shown, and exit ends the program normally', () => {
  expect(run('warn "w"\n$stderr.puts "e"\nputs "out"\nexit\nputs "after"')).toMatchObject({
    stdout: 'out\n',
    uncaughtException: undefined,
  });
});

test('a run does not see the methods an earlier run added to library classes', () => {
  expect(run('class Integer\n  def double = self * 2\nend\np 2.double')).toMatchObject({ stdout: '4\n' });
  expect(run('p 2.double')).toMatchObject({
    uncaughtException: "undefined method 'double' for an instance of Integer (NoMethodError)",
  });
});
