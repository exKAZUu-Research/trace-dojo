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

test.each([
  ['empty arrays in puts', 'puts []; puts "after"', 'after\n'],
  ['symbol keys in Hash inspection', 'p({:+ => 1, :a= => 2, :@x => 3})', '{"+": 1, "a=": 2, "@x": 3}\n'],
  ['cyclic array equality', 'a = []; a << a; b = []; b << b; p a == b', 'true\n'],
  ['minmax_by block calls', 'n=0; p [3,1,2].minmax_by { |x| n+=1; x }; p n', '[1, 3]\n3\n'],
  ['receiver local in index', 'p (a = [10, 20])[a.size - 1]', '20\n'],
  ['character indexes after emoji', 's = "😀a😀b"; p s.index("b"); p s.rindex("a")', '3\n1\n'],
  ['named format substitution', 'p format("%{name}!", name: "Ruby")', '"Ruby!"\n'],
  ['negative Float integer formatting', 'p format("%d", -1.2)', '"-1"\n'],
  ['hexadecimal Float rounding', 'p format("%.1a", 1.99); p format("%.0a", 1.75)', '"0x1.0p+1"\n"0x1p+1"\n'],
  ['an empty Hash shift', 'p Hash.new(5).shift; p Hash.new { |h,k| 7 }.shift', 'nil\nnil\n'],
  ['an overridden Hash default', 'class H < Hash; def default(k = nil); 42; end; end; p H.new[:x]', '42\n'],
  ['leading-dot Float conversion', 'p ".5".to_f; p "-.5".to_f', '0.5\n-0.5\n'],
  [
    'Range membership',
    'p ("a".."e").include?("bb"), (1..5).include?(2..3), (1..5).cover?(2..3)',
    'false\nfalse\ntrue\n',
  ],
  ['large Integer square root', 'p Integer.sqrt(10 ** 100)', `${'1' + '0'.repeat(50)}\n`],
  ['assignment target evaluation order', 'a=[0,0]; i=0; a[i]=(i=1); p a', '[1, 0]\n'],
  ['qualified constant initialization', 'module A; end; A::X ||= 1; p A::X', '1\n'],
  ['qualified constant scope evaluation', 'module A; X=0; end; def f; puts "f"; A; end; f::X += 1; p A::X', 'f\n1\n'],
  ['top-level return from a block', 'puts :before; 1.times { return }; puts :after', 'before\n'],
  ['class-body return from a block', 'class Foo; [1].each { return }; end; puts "after"', ''],
  ['block-local variable', 'p [[1,2]].map { |x; y| [x,y] }', '[[[1, 2], nil]]\n'],
  [
    'anonymous rest forwarded by super',
    'class A; def f(*x); p x; end; end; class B < A; def f(*); super; end; end; B.new.f(1,2)',
    '[1, 2]\n',
  ],
  ['UTF-8 escaped bytes', String.raw`p "\xC3\xA9"`, '"é"\n'],
  ['invalid UTF-8 escaped byte', String.raw`p "\xFF"; p "\xFF".bytes`, '"\\xFF"\n[255]\n'],
  [
    'invalid UTF-8 byte access',
    String.raw`p "\xFF".bytesize, "\xFF".getbyte(0), "\xFF".each_byte.to_a`,
    '1\n255\n[255]\n',
  ],
  ['meta escaped byte', String.raw`p "\M-a".bytesize; p "\M-a".bytes`, '1\n[225]\n'],
  ['nested meta and control escapes', String.raw`p "\M-\C-a".bytes; p "\c\M-a".bytes`, '[129]\n[129]\n'],
  [
    'escaped byte in a frozen Hash key',
    String.raw`h={}; h["\xFF"]=1; p h.keys[0]; p h.keys[0].bytes`,
    '"\\xFF"\n[255]\n',
  ],
  ['both Float zeros as one Hash key', 'h={}; h[-0.0]=1; h[0.0]=2; p h.size; p h[-0.0]', '1\n2\n'],
  ['index receiver before index locals', '(a = [0])[a.size - 1] = 7; p a', '[7]\n'],
  [
    'mixed UTF-8 text and escaped bytes',
    String.raw`p "é\xFF", "\xFFé"; p "\xFFé".bytes; p "\xFFé".bytesize`,
    '"é\\xFF"\n"\\xFFé"\n[255, 195, 169]\n3\n',
  ],
  [
    'Array set operations with colliding hashes',
    'class Key; def hash; 1; end; end; a=Key.new; b=Key.new; p [a,b].uniq.size; p ([a]-[b]).size; p ([a]&[b]).size',
    '2\n1\n0\n',
  ],
  ['negative Array and Enumerable cycle counts', 'p [1].cycle(-1) { |x| x }; p (1..2).cycle(-2).to_a', 'nil\n[]\n'],
  ['negative combination size', '[1].combination(-1) { |x| p x }; puts "done"', 'done\n'],
  ['Kernel module functions', 'Kernel.puts("x"); p Kernel.format("%d", 2)', 'x\n"2"\n'],
  ['clone retains an extended module', 'module M; def m; 1; end; end; o=Object.new.extend(M); p o.clone.m', '1\n'],
  [
    'Random duplication copies generator state',
    'r=Random.new(1); s=r.dup; p r.rand,s.rand',
    '0.417022004702574\n0.417022004702574\n',
  ],
  [
    'initialize_copy can call super',
    'class P; attr_reader :x; def initialize_copy(o); super; @x=2; end; end; p P.new.dup.x',
    '2\n',
  ],
  ['short String range traversal', 'p ("000000".."999999").first(3)', '["000000", "000001", "000002"]\n'],
  [
    'a bang substitution that matches without changing text',
    's="abc"; p s.sub!("a", "a"); p s.tr!("a", "a")',
    '"abc"\n"abc"\n',
  ],
  ['empty-pattern substitution around emoji', 'p "😀".gsub("", ".")', '".😀."\n'],
  [
    'sort_by with a redefined numeric comparator',
    'class Integer; def <=>(other); other - self; end; end; p [1,2,3].sort_by { |x| x }',
    '[3, 2, 1]\n',
  ],
  ['String dump escapes Unicode', 'p "あ".dump; p "😀".dump', '"\\"\\\\u3042\\""\n"\\"\\\\u{1F600}\\""\n'],
  ['nil String line and chomp separators', 'p "x".lines(nil); p "x".chomp(nil)', '["x"]\n"x"\n'],
  ['Array fill beyond the end', 'a=[1,2]; p a.fill(0,5); p a.fill(0,5..7)', '[1, 2]\n[1, 2, nil, nil, nil, 0, 0, 0]\n'],
  ['Array values_at beyond the end', 'p [1,2].values_at(5..7)', '[nil, nil, nil]\n'],
  [
    'array state during deletion',
    'a=[1,2,3]; a.delete_if { |x| p a; x == 1 }; p a',
    '[1, 2, 3]\n[1, 2, 3]\n[2, 2, 3]\n[2, 3]\n',
  ],
  [
    'anonymous keyword rest through super',
    'class A; def f(*x,**k); p [x,k]; end; end; class B<A; def f(*,**); super; end; end; B.new.f(1,2,a:3)',
    '[[1, 2], {a: 3}]\n',
  ],
  [
    'array deletion before a rescued error',
    'a=[1,2,3]; begin; a.delete_if { |x| raise if x == 3; x == 1 }; rescue; end; p a',
    '[2, 3]\n',
  ],
  [
    'Float neighbors at infinity',
    'p Float::INFINITY.next_float; p (-Float::INFINITY).prev_float',
    'Infinity\n-Infinity\n',
  ],
  ['Ruby control escape', String.raw`p "\C-a"`, '"\\u0001"\n'],
])('%s matches Ruby output', (_name, program, stdout) => {
  expect(run(program)).toMatchObject({ kind: 'executed', stdout, uncaughtException: undefined });
});

test('cyclic module inclusion raises a Ruby error', () => {
  expect(run('module A; end; module B; include A; end; module A; include B; end')).toMatchObject({
    uncaughtException: 'cyclic include detected (ArgumentError)',
  });
});

test('a positional splat after keyword arguments is rejected before execution', () => {
  expect(run('puts "before"; def f(*a, **k); end; f(a: 1, *[])')).toMatchObject({ kind: 'compileError' });
});

test('a positional argument after a bare keyword hash is rejected before execution', () => {
  expect(run('def f(*a, **kw); end; f(a: 1, 2)')).toMatchObject({ kind: 'compileError' });
});

test('misordered method parameters are rejected before execution', () => {
  expect(run('def f(a: 1, b); end')).toMatchObject({ kind: 'compileError' });
  expect(run('def f(*a, b = 1); end')).toMatchObject({ kind: 'compileError' });
});

test('unsupported source-location constants report their feature', () => {
  expect(run('puts __FILE__')).toMatchObject({ kind: 'compileError' });
});

test('invalid Unicode scalar escapes are compile errors', () => {
  expect(run(String.raw`puts "\u{110000}"`)).toMatchObject({ kind: 'compileError' });
  expect(run(String.raw`puts "\uD800"`)).toMatchObject({ kind: 'compileError' });
});

test('Hash default_proc rejects non-Procs at assignment', () => {
  expect(run('h = {}; h.default_proc = 3')).toMatchObject({
    uncaughtException: 'wrong default_proc type Integer (expected Proc) (TypeError)',
  });
});

test('Hash mutation during in-place filtering raises an error', () => {
  expect(run('h = {a: 1}; h.delete_if { |k,v| h[:b] = 2; false }')).toMatchObject({
    uncaughtException: "can't add a new key into hash during iteration (RuntimeError)",
  });
});

test('Hash mutation during transform_values! raises an error', () => {
  expect(run('h={a:1}; h.transform_values! { |v| h[:b]=2; v }')).toMatchObject({
    uncaughtException: "can't add a new key into hash during iteration (RuntimeError)",
  });
});

test('group_by charges retained array slots', () => {
  expect(run('big=Array.new(999000); small=Array.new(600,1); small.group_by { |x| 0 }')).toEqual({
    kind: 'limitExceeded',
    limit: 'storage',
  });
});

test('a private setter rejects an explicit receiver', () => {
  expect(run('class A; private; attr_writer :x; end; A.new.x = 1')).toMatchObject({
    uncaughtException: "private method 'x=' called for an instance of A (NoMethodError)",
  });
});

test('out-of-range String append and missing inject block raise Ruby errors', () => {
  expect(run('"a" << 1114112')).toMatchObject({ uncaughtException: '1114112 out of char range (RangeError)' });
  expect(run('[3,1,2].inject')).toMatchObject({ uncaughtException: 'no block given (LocalJumpError)' });
});

test('a default initializer rejects unexpected arguments', () => {
  expect(run('Object.new(1)')).toMatchObject({
    uncaughtException: 'wrong number of arguments (given 1, expected 0) (ArgumentError)',
  });
});

test('frozen bang String methods reject even unchanged results', () => {
  expect(run('s="a".freeze; s.delete!("x")')).toMatchObject({
    uncaughtException: expect.stringContaining('FrozenError'),
  });
});

test('ensure exposes and preserves a pending exception', () => {
  expect(run('begin; raise "boom"; ensure; p $!; raise; end')).toMatchObject({
    stdout: '#<RuntimeError: boom>\n',
    uncaughtException: 'boom (RuntimeError)',
  });
});

test('a block return after its class body has ended raises a Ruby error', () => {
  expect(run('class Foo; PR = proc { return }; end; Foo::PR.call')).toMatchObject({
    uncaughtException: 'unexpected return (LocalJumpError)',
  });
});

test('puts limits exponentially nested output before flattening it', () => {
  expect(run('a = ["x"]\n25.times { a = [a, a] }\nputs a')).toEqual({ kind: 'limitExceeded', limit: 'output' });
});

test('repeated big integer multiplication respects the operation limit', () => {
  expect(run('x = 2; 30.times { x = x * x }')).toEqual({ kind: 'limitExceeded', limit: 'operations' });
});

test('Ruby array allocation respects the shared storage limit', () => {
  expect(run('a = Array.new(1000001); puts a.size')).toEqual({ kind: 'limitExceeded', limit: 'storage' });
  expect(run('b=[0]*600000; a=[]; a.replace(b); p a.size+b.size')).toEqual({ kind: 'limitExceeded', limit: 'storage' });
});

test('large formatting and array products stop before building oversized results', () => {
  expect(run('p "a".ljust(10**9).size')).toEqual({ kind: 'limitExceeded', limit: 'storage' });
  expect(run('p format("%1000000000d", 1).size')).toEqual({ kind: 'limitExceeded', limit: 'storage' });
  expect(run('a = [0] * 3000; p a.product(a, a).size')).toEqual({ kind: 'limitExceeded', limit: 'storage' });
});

test('large arrays remain traceable within the storage limit', () => {
  expect(run('t = Turtle.new; a = Array.new(200000, 0); t.forward; p a.size')).toMatchObject({
    kind: 'executed',
    stdout: '200000\n',
  });
  expect(run('a = Array.new(200000, 0); p (a * 2).size')).toMatchObject({
    kind: 'executed',
    stdout: '400000\n',
  });
});

test.each([
  [
    'distinct array keys',
    'h = {}\nh[["a,sb"]] = 1\nh[["a", "b"]] = 2\np h.size\np h[["a,sb"]]\np h[["a", "b"]]',
    '2\n1\n2\n',
  ],
  ['a recursive array key', 'a = []\na << a\nh = {}\nh[a] = 1\np h[a]', '1\n'],
  ['equivalent recursive array keys', 'a = []\na << a\nb = []\nb << b\nh = {}\nh[a] = 1\np h[b]', '1\n'],
  ['equivalent cyclic graphs', 'a = []; a << a; b = []; c = []; b << c; c << b; h = {a => 1}; p h[b]', '1\n'],
  ['a hash containing itself as a value', 'a = {}\na[:self] = a\nh = {}\nh[a] = 1\np h[a]', '1\n'],
  [
    'a colliding key after deletion',
    'class Key; def hash; 1; end; end; a = Key.new; b = Key.new; h = {}; h[a] = 1; h[b] = 2; h.delete(a); p h[b]; p h.size',
    '2\n1\n',
  ],
])('%s retains its Hash entry', (_name, program, stdout) => {
  expect(run(program)).toMatchObject({ kind: 'executed', stdout, uncaughtException: undefined });
});

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
])(
  '%s stops the program with the unsupported-feature message, which rescue cannot catch',
  (_name, program, message) => {
    const execution = run(`puts "before"\nbegin\n  ${program}\nrescue Exception\n  puts "rescued"\nend`);
    expect(execution).toMatchObject({ kind: 'executed', stdout: 'before\n', uncaughtException: message });
  }
);

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
