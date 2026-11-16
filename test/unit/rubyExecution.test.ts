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

test('shared module ancestry stays bounded', () => {
  let program = 'module A0;end\nmodule B0;end\n';
  for (let index = 1; index <= 26; index++)
    program += `module A${index};include A${index - 1},B${index - 1};end\nmodule B${index};include A${index - 1},B${index - 1};end\n`;
  expect(run(`${program}p A26.ancestors.size`)).toMatchObject({ kind: 'executed', stdout: '53\n' });
});

test('shared prepended ancestry stays bounded', () => {
  let program = 'module A0;end\nmodule B0;end\n';
  for (let index = 1; index <= 26; index++)
    program += `module A${index};prepend A${index - 1},B${index - 1};end\nmodule B${index};prepend A${index - 1},B${index - 1};end\n`;
  const result = run(`${program}p A26.ancestors.size`);
  if (result.kind !== 'executed') throw new Error(`prepend ancestry did not run: ${JSON.stringify(result)}`);
  expect(result.stdout).toMatch(/^\d+\n$/);
});

test('unterminated heredoc rejects the program before execution', () => {
  expect(run('puts "start"\nx = <<~EOS\n  text\n')).toMatchObject({ kind: 'compileError' });
});

test('Regexp supports negated class shorthands and rejects unavailable syntax', () => {
  expect(run(String.raw`p "a".match?(/\X/)`)).toMatchObject({
    uncaughtException: String.raw`正規表現の\X は、この採点環境では使えません。`,
  });
  expect(run(String.raw`p "g".match?(/[\H]/)`)).toMatchObject({
    stdout: 'true\n',
    uncaughtException: undefined,
  });
  expect(run(String.raw`p "g".match?(/[\S]/)`)).toMatchObject({
    stdout: 'true\n',
    uncaughtException: undefined,
  });
});

test('regexp splitting and MatchData slicing match Ruby output', () => {
  const result = run(String.raw`p "a b c".split(/( )/, 2)
m = /(a)(b)(c)/.match("abc")
p m[1..], m[1..2], m[7, 2], m == /(a)(b)(c)/.match("abc")
p /a\/b/.source, /a\/b/ == Regexp.new("a/b")
`);
  expect(result).toMatchObject({
    kind: 'executed',
    stdout: '["a", " ", "b c"]\n["a", "b", "c"]\n["a", "b"]\nnil\ntrue\n"a/b"\ntrue\n',
  });
});

test('literal braces and Unicode word boundaries match Ruby', () => {
  expect(
    run(String.raw`p "Hello {name}!".gsub(/{(\w+)}/) { $1.upcase }
p "a]b" =~ /]/
p "café au" =~ /é\b/
p "日本語 text".scan(/\b\S+\b/)
`)
  ).toMatchObject({ kind: 'executed', stdout: '"Hello NAME!"\n1\n3\n["日本語", "text"]\n' });
});

test('Time inspection and UTC names retain Ruby values', () => {
  expect(run('p Time.at(1.1).utc; p Time.utc(99); p Time.new(2024, 1, 1, 0, 0, 0, "Z")')).toMatchObject({
    kind: 'executed',
    stdout:
      '1970-01-01 00:00:01 225179981368525/2251799813685248 UTC\n0099-01-01 00:00:00 UTC\n2024-01-01 00:00:00 UTC\n',
  });
});

test('keyword method arity and nil regexp guards match Ruby', () => {
  expect(
    run(
      'class C; def f(k: 1); end; define_method(:g) { |k: 1| }; end; p C.new.method(:f).arity, C.new.method(:g).arity; p nil =~ /a/, :abc =~ /a/, nil ^ true'
    )
  ).toMatchObject({
    kind: 'executed',
    stdout: '-1\n-1\nnil\n0\ntrue\n',
  });
});

test('const_defined? rejects a non-constant name', () => {
  expect(run('String.const_defined?(:upcase)')).toMatchObject({
    uncaughtException: 'wrong constant name upcase (NameError)',
  });
});

test('Data rejects mixed positional and keyword construction', () => {
  expect(run('D=Data.define(:a,:b); D.new(1,b:2)')).toMatchObject({
    uncaughtException: 'wrong number of arguments (given 2, expected 0) (ArgumentError)',
  });
});

test('large Rational rounding precision stays within the execution budget', () => {
  expect(run('p Rational(1,2).round(10000000000)')).toMatchObject({ kind: 'limitExceeded' });
});

test('Rational comparison and truncation preserve Ruby numeric results', () => {
  expect(
    run('p Rational(1,2) <=> Float::NAN; p Rational(1234,1000).truncate(2); p Rational(-1234,1000).truncate(-1)')
  ).toMatchObject({
    kind: 'executed',
    stdout: 'nil\n(123/100)\n0\n',
  });
});

test('resolved conversions work without respond_to? and respect overrides', () => {
  expect(run('class A<BasicObject; def to_str = "x"; end; p "p" + A.new')).toMatchObject({
    stdout: '"px"\n',
  });
  expect(
    run(
      'module Kernel; def respond_to?(*) = false; end; class A; def method_missing(*) = "x"; end; begin; p "p" + A.new; rescue => e; p e.class; end'
    )
  ).toMatchObject({
    stdout: 'TypeError\n',
  });
});

test('calendar Time constructors retain exact fractional seconds', () => {
  expect(run('p Time.utc(1970,1,1,0,0,Rational(1,3)) == Time.at(Rational(1,3))')).toMatchObject({
    stdout: 'true\n',
  });
});

test('Method#to_proc forwards keyword arguments', () => {
  expect(run('def f(k:); p k; end; method(:f).to_proc.call(k: 3)')).toMatchObject({ stdout: '3\n' });
});

test('Regexp case comparison coerces strings and clears failed matches', () => {
  expect(run('o=Object.new; def o.to_str; "abc"; end; /a/=~"a"; p(/a/ === 1); p $~; p(/a/ === o)')).toMatchObject({
    stdout: 'false\nnil\ntrue\n',
  });
});

test('anonymous forwarding requires the matching parameter declaration', () => {
  expect(run('def f(...); g(*); end; def g(*a); a; end; p f(1)')).toMatchObject({ kind: 'compileError' });
  expect(run('def f(...); g(...); end; def g(*a,**k,&b); p a,k;end; f(1,x:2)')).toMatchObject({
    stdout: '[1]\n{x: 2}\n',
  });
});

test('undef in class_eval targets the evaluated class', () => {
  expect(run('class A; def x;1;end;end; A.class_eval { undef x }; p A.new.respond_to?(:x)')).toMatchObject({
    stdout: 'false\n',
  });
});

test('static regexp literals retain identity within a program', () => {
  expect(run('def f; /abc/; end; p f.equal?(f)')).toMatchObject({ stdout: 'true\n' });
});

test('quoted hash pattern keys decode their escapes', () => {
  expect(run(String.raw`p(({"a\n": 1} in {"a\n": 1}))`)).toMatchObject({ stdout: 'true\n' });
});

test('imaginary unit remains unsupported', () => {
  expect(run('p 1.i')).toMatchObject({
    uncaughtException: 'Numeric#i（複素数）は、この採点環境では使えません。',
  });
});

test('unimplemented core methods use the dedicated unsupported error', () => {
  expect(run('p "abc".byteindex("b")')).toMatchObject({
    uncaughtException: 'String#byteindex は、この採点環境では使えません。',
  });
  expect(run('proc{}.binding')).toMatchObject({ uncaughtException: 'Proc#binding は、この採点環境では使えません。' });
  expect(run('String.autoload(:X,"x")')).toMatchObject({
    uncaughtException: 'Module#autoload は、この採点環境では使えません。',
  });
});

test('an exception whose message fails still returns an execution result', () => {
  expect(run('class E<StandardError;def message;raise "oops";end;end;raise E')).toMatchObject({
    kind: 'executed',
    uncaughtException: 'E',
  });
});

test('Random#bytes uses the dedicated unsupported error', () => {
  expect(run('Random.new(1).bytes(4)')).toMatchObject({
    uncaughtException: 'Random#bytes は、この採点環境では使えません。',
  });
});

test('pretty-printing a flat large Array stays within the execution budget', () => {
  vi.restoreAllMocks();
  const result = run('pp [1] * 15000');
  expect(result).toMatchObject({ kind: 'executed' });
  if (result.kind === 'executed') expect(result.stdout).toHaveLength(60_000);
});

test('negative binary formatting stays within the execution budget', () => {
  vi.restoreAllMocks();
  expect(run('p format("%b", -(1<<900000)).bytesize')).toMatchObject({
    kind: 'executed',
    stdout: '900003\n',
  });
});

test('empty repetitions stay within the execution budget', () => {
  vi.restoreAllMocks();
  expect(run('p("" * 300000000, [] * 300000000)')).toMatchObject({
    kind: 'executed',
    stdout: '""\n[]\n',
  });
});

test('wide character-set ranges charge the execution budget before expansion', () => {
  expect(run(String.raw`p "a".count("\u0000-\u{10FFFF}")`)).toMatchObject({
    kind: 'limitExceeded',
    limit: 'operations',
  });
});

test('Ruby recursion reaches the shared call-depth limit under Node', () => {
  expect(run('def f(n); n==0 ? 0 : 1+f(n-1); end; p f(450)')).toMatchObject({
    kind: 'executed',
    stdout: '450\n',
  });
  expect(run('def f(n); n==0 ? 0 : [1].map { f(n-1) }[0]+1; end; p f(250)')).toMatchObject({
    kind: 'executed',
    stdout: '250\n',
  });
});

test('void expressions in value positions fail before execution', () => {
  for (const source of [
    'def f;x ||= return 1;end;puts f',
    'def f;p(return 1);end;puts f',
    'def f;if (return 1);2;end;end;p f',
    'def f;case (return 1);when 1;2;end;end;p f',
    'def f;for x in (return 1);end;end;p f',
    'def f;(return 1)::X;end;p f',
    'def f;(return 1)[0];end;p f',
    'def f;x=(1;return 2);end;p f',
    'def f;p(begin;return 1;end);end;p f',
  ])
    expect(run(source)).toMatchObject({ kind: 'compileError' });
});

test.each([
  [
    'Enumerable forwards iteration arguments',
    'class E;include Enumerable;def each(n);yield n;end;end;p E.new.to_a(3),E.new.each_with_index(4).to_a,E.new.each_entry(5).to_a,E.new.reverse_each(6).to_a',
    '[3]\n[[4, 0]]\n[5]\n[6]\n',
  ],
  [
    'array-like flattening',
    'class A;def to_ary;[1,2];end;end;p [A.new].flatten,[0].flat_map { A.new }',
    '[1, 2]\n[1, 2]\n',
  ],
  ['sort_by evaluates keys while iterating', 'a=[2,1];p a.sort_by{|x|a<<3 if x==2;x}', '[1, 2, 3]\n'],
  [
    'sum interleaves mapped values and arithmetic',
    'class N;def +(x);$n+=1;self;end;end;$n=0;[1,2].sum(N.new){|x|puts $n;x}',
    '0\n1\n',
  ],
  [
    'cycle yields during source iteration',
    'class E;include Enumerable;def each;puts :before;yield 1;puts :after;end;end;E.new.cycle(1){puts :block}',
    'before\nblock\nafter\n',
  ],
  [
    'grouping enumerators stop at the first boundary',
    'p [1,2,3].slice_when{|a,b|puts b;true}.first;p [1,2,3].chunk_while{|a,b|puts b;false}.first',
    '2\n[1]\n2\n[1]\n',
  ],
  [
    'chunk defers classification until consumed',
    'e=[1,2,3].chunk{|x|puts x;x};p e.class;p e.first',
    'Enumerator\n1\n2\n[1, [1]]\n',
  ],
  [
    'tally converts its accumulator',
    'class H;def to_hash;{1=>2};end;end;p [1].tally(H.new);begin;[1].tally(5);rescue => e;p e.class;end',
    '{1 => 3}\nTypeError\n',
  ],
  ['Proc arity includes keywords', 'p (->(x,y:1){}).arity,(->(x,y:){}).arity,(proc{|x,y:1|}).arity', '-2\n2\n1\n'],
  [
    'Hash and keyword splats convert through to_hash',
    'class H;def to_hash;{a:1};end;end;def f(a:);p a;end;p({**H.new});f(**H.new)',
    '{a: 1}\n1\n',
  ],
  [
    'splat nil conversion and invalid destructuring',
    'class A;def to_a;nil;end;def to_ary;1;end;end;a=A.new;p [*a].size;begin;x,y=a;rescue => e;p e.class;end',
    '1\nTypeError\n',
  ],
  [
    'frozen Hash rehash leaves entries intact',
    'h={a:1}.freeze;begin;h.rehash;rescue => e;p e.class;end;p h[:a]',
    'FrozenError\n1\n',
  ],
  [
    'Array product yields before allocating every tuple',
    'p Array.new(2000,1).product(Array.new(2000,2)) {|tuple| break :ok if tuple == [1,2]}',
    ':ok\n',
  ],
  [
    'Range to_s retains invalid endpoint bytes',
    String.raw`p ("\xFF".."a").to_s.bytes, ("\xFF"..."a").to_s.bytes`,
    '[255, 46, 46, 97]\n[255, 46, 46, 46, 97]\n',
  ],
  ['String subclass runs initialize', 'class S<String;attr_reader :n;def initialize;@n=7;end;end;p S.new.n', '7\n'],
  [
    'String slice mutation resolves its index once',
    'class I;def initialize;@n=0;end;def to_int;@n+=1;@n-1;end;end;s="abc";p s.slice!(I.new),s',
    '"a"\n"bc"\n',
  ],
  [
    'invalid UTF-8 String patterns follow method-specific errors',
    String.raw`begin;"a".count("\xFF");rescue => e;p e.class;end;begin;"a".gsub("\xFF","x");rescue => e;p e.class;end;begin;"a".split("\xFF");rescue => e;p e.class;end;p "a".partition("\xFF")`,
    'ArgumentError\nRegexpError\nArgumentError\n["a", "", ""]\n',
  ],
  [
    'invalid UTF-8 cannot form a Symbol',
    String.raw`begin;p "a\xFFb".to_sym;rescue => e;p e.class,e.message;end`,
    'EncodingError\n"invalid symbol in encoding UTF-8 :\\"a\\\\xFFb\\""\n',
  ],
  [
    'scan and gsub detect receiver mutation',
    's="aa";begin;s.scan("a"){|x|s<<"x"};rescue=>e;p e.class,e.message;end;s="aa";begin;s.gsub("a"){|x|s<<"x";"x"};rescue=>e;p e.class,e.message;end',
    'RuntimeError\n"string modified"\nRuntimeError\n"string modified"\n',
  ],
  ['gsub reads Hash default proc', 'p "aaa".gsub("a",Hash.new{|h,k|"X"})', '"XXX"\n'],
  [
    'substitution bypasses Hash lookup overrides',
    'class H<Hash;def [](x);puts :called;"x";end;end;p "a".gsub("a",H.new)',
    '""\n',
  ],
  [
    'String padding checks encoding compatibility',
    'begin;p 255.chr.center(3,"é");rescue=>e;p e.class;end',
    'Encoding::CompatibilityError\n',
  ],
  [
    'invalid UTF-8 successor advances the preceding Unicode character',
    String.raw`p "aé\xFF".succ.bytes,"é\xFF".succ.bytes,"😀\xFF".succ.bytes`,
    '[97, 195, 170, 255]\n[195, 170, 255]\n[240, 159, 152, 129, 255]\n',
  ],
  [
    'invalid UTF-8 upto stops after byte-length growth',
    String.raw`p "\xFE".upto("\xFF").to_a.map(&:bytes),"\xFE\xFE".upto("\xFF\xFF").to_a.map(&:bytes)`,
    '[[254]]\n[[254, 254]]\n',
  ],
  [
    'zip consumes only the receiver length from endless inputs',
    'p [1,2].zip((1..).each),(1..2).zip((1..).each)',
    '[[1, 1], [2, 2]]\n[[1, 1], [2, 2]]\n',
  ],
  [
    'zip pulls values from a learner-defined each method',
    'class E;include Enumerable;def each;yield 1;yield 2;end;end;p [3,4].zip(E.new)',
    '[[3, 1], [4, 2]]\n',
  ],
  [
    'Enumerable grep uses case equality and maps matching values',
    'p [1,5,"a",9].grep(Integer),[1,5,"a",9].grep_v(Integer);p (1..10).grep(3..5){|x|x*2}',
    '[1, 5, 9]\n["a"]\n[6, 8, 10]\n',
  ],
  [
    'Enumerable slice boundaries defer callbacks and yield groups',
    'p [1,2,6,7].slice_before{|x|x>5}.to_a,[1,2,6,7].slice_after{|x|x>5}.to_a;p [1,2,1].slice_before(1).to_a',
    '[[1, 2], [6], [7]]\n[[1, 2, 6], [7]]\n[[1, 2], [1]]\n',
  ],
  ['Array bsearch_index returns the selected index', 'p [1,3,5].bsearch_index{|x|x>=3}', '1\n'],
  [
    'Hash association, flattening, and conversion to Proc',
    'h={a:[1,2],b:3};p h.assoc(:a),h.rassoc(3),h.flatten,h.flatten(2),h.to_proc.call(:b)',
    '[:a, [1, 2]]\n[:b, 3]\n[:a, [1, 2], :b, 3]\n[:a, 1, 2, :b, 3]\n3\n',
  ],
  [
    'Range bsearch handles finite and open numeric bounds',
    'p (1..10).bsearch{|x|x>=4},(1...10).bsearch{|x|x>=10},(1..).bsearch{|x|x>=5},(..5).bsearch{|x|x>=3},(1.0..2.0).bsearch{|x|x>=1.5}',
    '4\nnil\n5\n3\n1.5\n',
  ],
  [
    'Enumerable chain retains its class, size, and source order',
    'e=[1,2].chain([3]);p e.class,e.size,e.to_a,e.inspect,e.each{}.equal?(e)',
    'Enumerator::Chain\n3\n[1, 2, 3]\n"#<Enumerator::Chain: [[1, 2], [3]]>"\ntrue\n',
  ],
  [
    'remaining core numeric and Range methods',
    'p 5.ceildiv(2),(-5).ceildiv(2),(1..4).overlap?(4..6),(1...4).overlap?(4..6)',
    '3\n-2\ntrue\nfalse\n',
  ],
  [
    'ArithmeticSequence first handles NaN and infinite bounds directly',
    'p 0.0.step(Float::NAN,1.0).first,0.0.step(Float::NAN,1.0).first(2),0.0.step(1.0,Float::INFINITY).first;begin;0.0.step(1.0,Float::NAN).first;rescue=>e;p e.class;end',
    '0.0\n[0.0, 1.0]\n0.0\nArgumentError\n',
  ],
  [
    'ArithmeticSequence first promotes Float values and checks infinite direction',
    'p 0.0.step(-1.0,Float::INFINITY).first(2),Float::NAN.step(1.0,1.0).first(2),1.step(Float::NAN,2).first(3),1.step(5,Float::INFINITY).first(2)',
    '[]\n[NaN, NaN]\n[1.0, 3.0, 5.0]\n[1.0]\n',
  ],
  [
    'Random subclass initializer receives its own arguments',
    'class R<Random;attr_reader :n;def initialize(x,y);super(x);@n=y;end;end;p R.new(1,7).n',
    '7\n',
  ],
  [
    'array-like Hash pairs convert through to_ary',
    'class A;def to_ary;[:a,1];end;end;p Hash[[A.new]],[A.new].to_h,(1..1).to_h{A.new},{x:2}.to_h{A.new}',
    '{a: 1}\n{a: 1}\n{a: 1}\n{a: 1}\n',
  ],
  [
    'Hash defaults survive conversion and compaction',
    'class H<Hash;end;h=H.new{|h,k|k};p h.to_h[:foo],h.compact[:bar],h.compact.class',
    ':foo\n:bar\nH\n',
  ],
  [
    'Hash to_proc uses native lookup despite subclass overrides',
    'class H<Hash;def [](k);puts :override;4;end;end;h=H.new;p [:x].map(&h)',
    '[nil]\n',
  ],
  [
    'Hash to_proc dispatches default overrides',
    'class H<Hash;def default(k);puts :default;7;end;end;h=H.new;p [:x].map(&h)',
    'default\n[7]\n',
  ],
  ['Hash except discards defaults', 'h=Hash.new(7);h[:a]=1;p h.except(:a)[:x]', 'nil\n'],
  [
    'rehash during iteration preserves Hash entries',
    'h={x:1};begin;h.each{|k,v|h.rehash};rescue=>e;p e.message,h;end',
    '"rehash during iteration"\n{x: 1}\n',
  ],
  [
    'rehash callback failure preserves Hash entries',
    'class K;def hash;raise "oops" if $fail;0;end;end;k=K.new;h={k=>1};$fail=true;begin;h.rehash;rescue=>e;p e.message,h.size;end',
    '"oops"\n1\n',
  ],
  [
    'rehash guards recursive key callbacks',
    'class K;attr_accessor :h;def hash;@h.rehash if @h;0;end;end;k=K.new;h={k=>1};k.h=h;begin;h.rehash;rescue=>e;p e.class,e.message,h.size;end',
    'RuntimeError\n"rehash during iteration"\n1\n',
  ],
  [
    'Array to_h errors use the runtime class',
    'class B;def class;raise "bad";end;end;begin;[B.new].to_h;rescue=>e;p e.class,e.message;end',
    'TypeError\n"wrong element type B at 0 (expected array)"\n',
  ],
  [
    'Array deconstruction, fetch_values, and reverse find',
    'p [1,2].deconstruct,[1,2].fetch_values(0,9){|i|i*2},[1,2,3].rfind{|x|x.even?}',
    '[1, 2]\n[1, 18]\n2\n',
  ],
  [
    'Set collection operations',
    's=Set[1,2,3];p s.classify{|x|x%2};p Set[Set[1,2],3].flatten;s.subtract([2]);p s;s.map!{|x|x*2};p s,s.join(",")',
    '{1 => Set[1, 3], 0 => Set[2]}\nSet[1, 2, 3]\nSet[1, 3]\nSet[2, 6]\n"2,6"\n',
  ],
  [
    'String padding validates encoding at every width',
    'begin;255.chr.center(0,"é");rescue=>e;p e.class;end',
    'Encoding::CompatibilityError\n',
  ],
  [
    'same-length String edits remain valid during callbacks',
    's="aaa";s.scan("a"){s[0]="b";puts :hit};s="aaa";p s.gsub("a"){s[0]="b";"x"}',
    'hit\nhit\nhit\n"xxx"\n',
  ],
  ['product snapshots inputs before yielding', 'a=[3,4];[1].product(a){|x|p x;a[1]=9}', '[1, 3]\n[1, 4]\n'],
  [
    'infinite arithmetic steps have a NaN last value',
    'e=1.0.step(3.0,-Float::INFINITY);p e.last(2),e.last',
    '[NaN]\nNaN\n',
  ],
  [
    'String subclass initializer owns its arity',
    'class S<String;def initialize(a,b);@n=a+b;end;attr_reader :n;end;p S.new(2,3).n',
    '5\n',
  ],
  [
    'long Array fetch errors preserve the exact index',
    'begin;[1].fetch(9007199254740993);rescue=>e;p e.message;end',
    '"index 9007199254740993 outside of array bounds: -1...1"\n',
  ],
  [
    'exclusive Float steps retain a value below a nearby endpoint',
    'e=(0.1...1.5000000000000002).step(0.1);p e.size,e.to_a.size,e.last',
    '15\n15\n1.4000000000000001\n',
  ],
  [
    'exclusive ArithmeticSequence last subtracts from the computed endpoint',
    'e=(0.0...0.30000000000000004).step(0.1);p e.last,e.last(2)',
    '0.20000000000000004\n[0.10000000000000003, 0.20000000000000004]\n',
  ],
  [
    'Unicode and invalid-byte String upto share successor rules',
    String.raw`p "aé".upto("aê").to_a,"a日".upto("a旦").to_a,"ab".upto("a\xFF").to_a.size,"a\xFF".upto("b").to_a.map(&:bytes)`,
    '["aé", "aê"]\n["a日", "a旦"]\n675\n[[97, 255]]\n',
  ],
  ['String upto compares initial values regardless of length', 'p "b".upto("ab").to_a,"z".upto("aa").to_a', '[]\n[]\n'],
  ['empty String upto terminates after yielding once', 'p "".upto("a").to_a,"".upto("a",true).to_a', '[""]\n[""]\n'],
  [
    'single-byte String upto crosses character classes',
    'p "Z".upto("a").to_a,"B".upto("c").to_a.size',
    '["Z", "[", "\\\\", "]", "^", "_", "`", "a"]\n34\n',
  ],
  [
    'String successor carries through letters but skips symbols',
    'p "😀9".succ,"a😀".succ,"€9".succ,"日9".succ',
    '"😀10"\n"b😀"\n"€10"\n"旦0"\n',
  ],
  [
    'String successor wraps Unicode digits and letters',
    'p "a９".succ,"９".succ,"٩".succ,"aｚ".succ,"a😀9".succ',
    '"b０"\n"１０"\n"١٠"\n"bａ"\n"a😀10"\n',
  ],
  [
    'empty String translations skip invalid patterns',
    String.raw`p "".tr("\xFF","x"),"".tr_s("\xFF","x"),"".tr!("\xFF","x"),"".delete("\xFF")`,
    '""\n""\nnil\n""\n',
  ],
  [
    'String successor carries into a preceding Unicode character',
    String.raw`p "日9\xFF".succ.bytes,"é9\xFF".succ.bytes,"日z\xFF".succ.bytes`,
    '[230, 151, 166, 48, 255]\n[195, 170, 48, 255]\n[230, 151, 166, 97, 255]\n',
  ],
  [
    'NaN Numeric steps iterate nothing but have invalid size',
    'e=0.0.step(Float::NAN,1.0);p e.to_a;begin;p e.size;rescue=>x;p x.class;end;begin;p 2.0.step(1.0,Float::NAN).size;rescue=>x;p x.class;end',
    '[]\nFloatDomainError\nFloatDomainError\n',
  ],
  [
    'private collection conversions are invoked implicitly',
    'class A;private;def to_hash;{a:1};end;def to_a;[2,3];end;def to_ary;[4,5];end;end;a=A.new;p({**a});p([*a]);x,y=a;p x,y',
    '{a: 1}\n[2, 3]\n4\n5\n',
  ],
  [
    'empty custom Range step stops after preflight',
    'class A;attr_reader :n;def initialize(n);@n=n;end;def <=>(o);puts :cmp;n<=>o.n;end;def +(v);puts :plus;A.new(n+v);end;end;(A.new(3)..A.new(1)).step(1){|x|p x.n}',
    'cmp\ncmp\nplus\ncmp\n',
  ],
  [
    'Float fraction methods retain whole-number numerators',
    'p 6.0.numerator,6.0.denominator,2.0.numerator,0.75.denominator',
    '6\n1\n2\n4\n',
  ],
  [
    'Math and Symbol core methods resolve',
    'p Math.gamma(5),Math.frexp(8.0),Math.ldexp(0.5,3),Math.log1p(0.5),Math.expm1(0.5);p :a.casecmp(:A),:b.casecmp?(:B),:a.intern',
    '24.0\n[0.5, 4]\n4.0\n0.4054651081081644\n0.6487212707001282\n0\ntrue\n:a\n',
  ],
  [
    'Math exponent helpers preserve extreme finite values',
    'p Math.frexp(Float::MAX),Math.frexp(2.0**53-1),Math.ldexp(3,-1076),Math.ldexp(0.5,1024)',
    '[0.9999999999999999, 1024]\n[0.9999999999999999, 53]\n5.0e-324\n8.98846567431158e+307\n',
  ],
  [
    'Math gamma handles signed zero and infinite domain',
    'p Math.gamma(-0.0),Math.gamma(0.0),Math.lgamma(-0.0),Math.lgamma(-1.0),Math.lgamma(1.0);begin;p Math.lgamma(-Float::INFINITY);rescue=>e;p e.class;end',
    `-Infinity\nInfinity\n[Infinity, -1]\n[Infinity, ${process.platform === 'linux' ? '-1' : '1'}]\n[0.0, 1]\nMath::DomainError\n`,
  ],
  [
    'Math gamma and lgamma match reference small arguments',
    'p Math.gamma(-0.5),Math.gamma(0.5),Math.gamma(2.5),Math.lgamma(3),Math.lgamma(5)',
    process.platform === 'linux'
      ? '-3.544907701811032\n1.772453850905516\n1.329340388179137\n[0.6931471805599453, 1]\n[3.1780538303479458, 1]\n'
      : '-3.5449077018110318\n1.772453850905516\n1.329340388179137\n[0.6931471805599454, 1]\n[3.1780538303479453, 1]\n',
  ],
  [
    'Kernel output preserves replacement-stream callbacks',
    'class W;attr_reader :calls;def initialize;@calls=[];end;def write(x);@calls<<[:write,x];end;def putc(x);@calls<<[:putc,x];end;end;w=W.new;old=$stdout;$stdout=w;putc 65;p 1,2;printf(w,"%s","x");$stdout=old;p w.calls',
    '[[:putc, 65], [:write, "1"], [:write, "\\n"], [:write, "2"], [:write, "\\n"], [:write, "x"]]\n',
  ],
  [
    'print uses output field and record separators',
    String.raw`$,=":";$\="!";print 1,2;STDOUT.print 3,4;print`,
    '1:2!3:4!!',
  ],
  ['print without arguments uses the last input line', '$_="hi";print;STDOUT.print', 'hihi'],
  [
    'exclusive Float step size stays bounded for tiny steps',
    'p (0.0...1.0).step(0.00000000000000000001).size',
    '100000000000000000000\n',
  ],
  [
    'fdiv and remainder honor private numeric coercion',
    'class A;private;def coerce(x);[x,2];end;end;a=A.new;p 5.fdiv(a),5.0.fdiv(a),5.remainder(a),5.0.remainder(a)',
    '2.5\n2.5\n1\n1.0\n',
  ],
  ['large Integer fdiv divides before Float rounding', 'p (10**400).fdiv(10**399)', '10.0\n'],
  ['Integer fdiv preserves signed zero', 'p 0.fdiv(-3),0.fdiv(-(10**400))', '-0.0\n-0.0\n'],
  [
    'Integer bit slices accept lengths and Ranges',
    'p 15[1,2],15[1..2],5[1...3],(-1)[-1,3],5[0,-1],5[1..]',
    '3\n3\n2\n6\n5\n2\n',
  ],
  ['record separator assignment copies a mutable String', 's="x";$/=s;s<<"y";p $/', '"x"\n'],
  [
    'paragraph line splitting consumes extra newlines',
    String.raw`s="a\n\n\nb";$/="";p s.lines,"\n\na\n\nb".lines,"a\n\n\n".lines`,
    '["a\\n\\n", "b"]\n["\\n\\n", "a\\n\\n", "b"]\n["a\\n\\n"]\n',
  ],
  [
    'Integer validates to_str before trying to_i',
    'class A;def to_str;false;end;def to_i;7;end;end;begin;p Integer(A.new);rescue=>e;p e.class;end',
    'TypeError\n',
  ],
  ['empty arrays in puts', 'puts []; puts "after"', 'after\n'],
  ['symbol keys in Hash inspection', 'p({:+ => 1, :a= => 2, :@x => 3})', '{"+": 1, "a=": 2, "@x": 3}\n'],
  ['cyclic array equality', 'a = []; a << a; b = []; b << b; p a == b', 'true\n'],
  ['minmax_by block calls', 'n=0; p [3,1,2].minmax_by { |x| n+=1; x }; p n', '[1, 3]\n3\n'],
  [
    'multiword Random seeds',
    'p Random.new(2**32).rand, Random.new(2**64).rand, Random.new(-(2**32)).rand',
    '0.8444218515250481\n0.1507172537105722\n0.8444218515250481\n',
  ],
  [
    'error-function tails',
    'p Math.erf(0.5), Math.erf(5), Math.erfc(6), Math.erfc(-6), Math.erf(Float::INFINITY)',
    '0.5204998778130465\n0.9999999999984626\n2.1519736712498913e-17\n2.0\n1.0\n',
  ],
  [
    'saturated error-function tails',
    'p Math.erf(10.0**100), Math.erfc(10.0**100), Math.erf(-10.0**100), Math.erfc(-10.0**100)',
    '1.0\n0.0\n-1.0\n2.0\n',
  ],
  [
    'Enumerator each arguments',
    'e=[1,2,3].each_slice(1); p e.each.equal?(e); a=e.each(2); p a.size; begin; a.to_a; rescue => x; p x.class; end',
    'true\nnil\nArgumentError\n',
  ],
  [
    'custom Enumerator each arguments retain iteration',
    'e=[1,2,3].chunk_while{|a,b|a<b}; x=e.each(1); p x.to_a, x.size',
    '[[1, 2, 3]]\nnil\n',
  ],
  ['blockless then Enumerator', 'p 1.then.size, 1.yield_self.each { |x| x+1 }', '1\n2\n'],
  [
    'String names for to_enum',
    'class M; def to_str; "each"; end; end; p [1,2].to_enum("each").to_a, [1,2].enum_for(M.new).to_a',
    '[1, 2]\n[1, 2]\n',
  ],
  [
    'Kernel String conversion priority',
    'class X; def to_str; "yes"; end; def to_s; "no"; end; end; p String(X.new)',
    '"yes"\n',
  ],
  [
    'Kernel collection conversion results',
    'class A; def to_ary; nil; end; def to_a; [1]; end; end; class H; def to_hash; 1; end; end; p Array(A.new); begin; Hash(H.new); rescue => e; p e.message; end',
    '[1]\n"can\'t convert H to Hash (H#to_hash gives Integer)"\n',
  ],
  [
    'display passes receiver to selected stream',
    'class W; def write(x); p [x.class, x]; end; end; 1.display(W.new)',
    '[Integer, 1]\n',
  ],
  [
    'frozen class rejects method and ancestor changes',
    'class C; end; module M; end; C.freeze; begin; class C; def x; end; end; rescue => e; p e.class; end; begin; C.include(M); rescue => e; p e.class; end',
    'FrozenError\nFrozenError\n',
  ],
  [
    'formatted binary String encoding',
    's=255.chr; p format("%s", s).bytes; p format("%sé", s).bytes; begin; format("é%s", s); rescue Encoding::CompatibilityError; puts :incompatible; end',
    '[255]\n[255, 195, 169]\nincompatible\n',
  ],
  [
    'printf validates formatted String encoding',
    'begin; printf("é%s",255.chr); rescue Encoding::CompatibilityError; puts :incompatible; end',
    'incompatible\n',
  ],
  [
    'dynamic format sizes use to_int',
    'class A; def to_int; 2; end; end; p format("%*s", A.new, "x"), format("%.*f", A.new, 1.234)',
    '" x"\n"1.23"\n',
  ],
  ['Float remainder by Integer zero', 'begin; 1.0.remainder(0); rescue ZeroDivisionError; puts :zero; end', 'zero\n'],
  [
    'Enumerator sizes and arithmetic sequence inspection',
    'p [1,2].each_with_index.size, 5.upto(7).size, "abc".each_char.size, [1,2,3].each_slice(2).size, [1,2].select.size, (1..4).each_cons(2).size, 10.downto(1).size, 1.step(10,3).size, (1..10).step(2).size; p 1.step(10,3), (1..10).step(3), (1..10).step, (1..10) % 2, 1.step(to: 10, by: 2); p 1.step(10,3).class',
    '2\n3\n3\n2\n2\n3\n10\n4\n5\n(1.step(10, 3))\n((1..10).step(3))\n((1..10).step)\n((1..10).%(2))\n(1.step(to: 10, by: 2))\nEnumerator::ArithmeticSequence\n',
  ],
  [
    'Set and Array selection Enumerator sizes',
    'p Set[1,2].each.size, [1,2,3].combination(2).size, [1,2,3].permutation(2).size, [1,2,3].repeated_combination(2).size, [1,2,3].repeated_permutation(2).size',
    '2\n3\n6\n6\n9\n',
  ],
  [
    'Enumerable sizes over Range and Set',
    'p (1..3).map.size, Set[1,2].sort_by.size, [1,2].each.map.size, loop.size, 1.upto(2.5).size, 3.downto(1.5).size',
    '3\n2\n2\nInfinity\n2\n2\n',
  ],
  [
    'ArithmeticSequence accessors and equality',
    'e=1.step(10,3); p e.begin,e.end,e.step,e.last,e.exclude_end?,e == (1..10).step(3)',
    '1\n10\n3\n10\nfalse\ntrue\n',
  ],
  [
    'ArithmeticSequence last and structural hash',
    'e=1.step(10,3); p e.last, e.last(2), e.last(0); p [e,e].uniq.size; h={e=>1}; p h[1.step(10,3)]; p (0.1..0.3).step(0.1).last, 1.0.step(0.0,-0.1).last, 1.step(10**400,2).last == 10**400-1',
    '10\n[7, 10]\n[]\n1\n1\n0.2\n0.0\ntrue\n',
  ],
  [
    'Float ArithmeticSequence last values and typed hash',
    'p (0.0...1.0).step(0.1).last(3), 1.0.step(0.0,-0.1).last(3); a=1.step(10,3); b=1.0.step(10,3); h={a=>7}; p a.eql?(b), a.hash==b.hash, h[b]; begin; 1.0.step(Float::NAN,1).last; rescue => e; p e.class; end',
    '[0.7, 0.7999999999999999, 0.8999999999999999]\n[0.20000000000000004, 0.10000000000000003, 2.7755575615628914e-17]\ntrue\nfalse\nnil\nFloatDomainError\n',
  ],
  [
    'NaN ArithmeticSequence size reports Ruby error',
    'begin; 1.0.step(Float::NAN,1).size; rescue => e; p [e.class,e.message]; end',
    '[FloatDomainError, "NaN"]\n',
  ],
  ['block arguments use to_ary', 'class A; def to_ary; [1,2]; end; end; [A.new].each { |a,b| p [a,b] }', '[1, 2]\n'],
  [
    'String separators use the input record separator',
    'p $/; $/="x"; p "abx".chomp, "abx".lines, "abx".each_line.to_a; $/=nil; p "abx".chomp',
    '"\\n"\n"ab"\n["abx"]\n["abx"]\n"abx"\n',
  ],
  [
    'Integer iteration near Float precision boundary',
    'a=2**53; p a.upto(a.to_f).to_a, (a+1).upto(a.to_f).to_a, (a+1).downto(a.to_f).to_a',
    '[9007199254740992]\n[]\n[9007199254740993, 9007199254740992]\n',
  ],
  [
    'Integer Range with a Float endpoint',
    'p (9007199254740993..9007199254740994.0).to_a, (9007199254740993...9007199254740994.0).to_a',
    '[9007199254740993, 9007199254740994]\n[9007199254740993]\n',
  ],
  [
    'Float step stops before a computed short limit',
    'x=0.0; 52.times { x+=0.1 }; p (0.0..x).step(0.1).to_a.size, (0.0..x).step(0.1).to_a.last(2), 0.0.step(x,0.1).to_a.size',
    '52\n[5.0, 5.1000000000000005]\n52\n',
  ],
  [
    'numeric conversion and argument boundaries',
    'class X; def coerce(a); [2.0,4]; end; end; p 1.quo(X.new); begin; 1.quo(nil); rescue => e; p e.message; end; begin; 1.5.round(10**30); rescue => e; p e.class; end; begin; 1.to_s(10**30); rescue => e; p e.class; end; begin; 1.step(5,2,by:3); rescue => e; p e.message; end',
    '0.5\n"nil can\'t be coerced into Rational"\nRangeError\nRangeError\n"step is given twice"\n',
  ],
  [
    'Integer conversion from string-like values',
    'class A; def to_str; "12"; end; def to_int; 5; end; end; class B; def to_str; "12"; end; def to_i; 7; end; end; p Integer(A.new), Integer(A.new,10), Integer(B.new)',
    '5\n12\n12\n',
  ],
  [
    'real Numeric methods and exact Float fractions',
    'p 5.numerator,5.denominator,5.real?,5.real,5.imag,5.abs2,5.conj,5.polar,5.rect,5.arg; p 0.1.numerator,0.1.denominator,-0.0.arg',
    '5\n1\ntrue\n5\n0\n25\n5\n[5, 0]\n[5, 0]\n0\n3602879701896397\n36028797018963968\n3.141592653589793\n',
  ],
  ['underscores in Float exponents', 'p "1e2_1".to_f, "1e2__1".to_f', '1.0e+21\n100.0\n'],
  ['Cherokee full case folding', 'p "Ꭱ".casecmp?("ꭱ")', 'true\n'],
  [
    'invalid UTF-8 bytes survive String operations',
    String.raw`p "a\xFFb".lines, "a\xFFb".sub("b","c"), "a\xFFb".delete_prefix("a"), "a\xFFb".delete_suffix("b")`,
    '["a\\xFFb"]\n"a\\xFFc"\n"\\xFFb"\n"a\\xFF"\n',
  ],
  [
    'invalid UTF-8 search and transform behavior',
    String.raw`p "a\xFFb".include?("\xFF"), "a\xFFb".index("\xFF"), "\xFF" <=> "\xFE", "\x80" <=> "é"; begin; "a\xFFb".tr("b","c"); rescue => e; p e.class; end`,
    'false\nnil\n1\n-1\nArgumentError\n',
  ],
  [
    'invalid UTF-8 strip positions',
    String.raw`p "a\xFFb".lstrip.bytes; begin; "a\xFF".strip; rescue => e; p e.class; end; begin; "\xFFa".lstrip; rescue => e; p e.class; end`,
    '[97, 255, 98]\nEncoding::CompatibilityError\nArgumentError\n',
  ],
  [
    'byte slicing, codepoints, and grapheme clusters',
    String.raw`p "é".byteslice(0).bytes, "é".byteslice(1).bytes, "abc".byteslice(1,2), "abc".each_codepoint.to_a, "e\u0301a".grapheme_clusters`,
    '[195]\n[169]\n"bc"\n[97, 98, 99]\n["é", "a"]\n',
  ],
  [
    'byte-preserving prefix and suffix mutation',
    String.raw`s="\xFFa"; p s.delete_prefix("\xFF").bytes, s.delete_suffix("a").bytes; p s.delete_prefix!("\xFF").bytes, s.bytes`,
    '[97]\n[255]\n[97]\n[97]\n',
  ],
  [
    'Set symmetric difference hash callbacks',
    'class K; def hash; puts :hash; 0; end; end; a=K.new; b=K.new; s=Set[a]; t=Set[b]; puts :start; p (s^t).size; puts :again; p (s^s).size',
    'hash\nhash\nstart\nhash\n2\nagain\nhash\nhash\n0\n',
  ],
  [
    'Array construction and slice assignment use to_ary',
    'class A; def to_ary; [4,5]; end; end; a=[1,2,3]; a[1,1]=A.new; p a, Array.new(A.new)',
    '[1, 4, 5, 3]\n[4, 5]\n',
  ],
  [
    'Array slice mutation converts index once',
    'class I; def initialize; @i=-1; end; def to_int; @i+=1; end; end; a=[10,20]; p a.slice!(I.new),a',
    '10\n[20]\n',
  ],
  ['Array count follows receiver mutation', 'a=[1]; p a.count { |x| a<<2 if x==1; true }', '2\n'],
  [
    'Array join preserves bytes and conversion order',
    String.raw`class A; def to_ary; [1,2]; end; end; p ["a","b"].join("\xFF").bytes, ["\xFF","z"].join.bytes, [A.new].join(",")`,
    '[97, 255, 98]\n[255, 122]\n"1,2"\n',
  ],
  [
    'Hash bracket constructor uses implicit collection conversions',
    'class H; def to_hash; {a:1}; end; end; class A; def to_ary; [[:b,2]]; end; end; p Hash[H.new], Hash[A.new]',
    '{a: 1}\n{b: 2}\n',
  ],
  ['Hash buckets follow transformed keys', 'h={a:1}; h.transform_keys!({a: :b}); p h.delete(:b), h', '1\n{}\n'],
  ['indexes within Ruby long range can be out of bounds', 'p "a"[2**53], [1][2**53]', 'nil\nnil\n'],
  [
    'split with limit one preserves invalid bytes',
    String.raw`p "a\xFF".split(",",1).map(&:bytes), "a\xFF".split(nil,1).map(&:bytes), "".split(",",1)`,
    '[[97, 255]]\n[[97, 255]]\n[]\n',
  ],
  [
    'replacement stdout receives original bytes and puts calls',
    String.raw`class W; attr_reader :chunks; def initialize; @chunks=[]; end; def write(x); @chunks << x.bytes; end; end; w=W.new; old=$stdout; $stdout=w; print "\xFF"; puts 12; puts "\xFF"; $stdout=old; p w.chunks`,
    '[[255], [49, 50], [10], [255], [10]]\n',
  ],
  [
    'Float identities distinguish values and signed zero',
    'p 1.5.object_id==3.5.object_id, 1.5.object_id==1.5.object_id, 0.0.object_id==(-0.0).object_id, 0.0.object_id==Float::NAN.object_id, 0.0.equal?(-0.0), Float::NAN.equal?(Float::NAN)',
    'false\ntrue\nfalse\nfalse\nfalse\ntrue\n',
  ],
  [
    'String sum long bound',
    'begin; "abc".sum(2**63); rescue RangeError => e; puts e.message; end; p "abc".sum(8)',
    "bignum too big to convert into 'long'\n38\n",
  ],
  ['character format precision', String.raw`p format("%3.0c", "x"); p format("%.0c", "\xFF").bytes`, '"  x"\n[255]\n'],
  [
    'frozen String prepend checks before arguments',
    'begin; "a".freeze.prepend(nil); rescue => e; p e.class; end',
    'FrozenError\n',
  ],
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
  [
    'Array subclass Hash overrides',
    'class A < Array; def hash; 0; end; def eql?(other); true; end; end; a=A.new([1]); b=A.new([2]); h={}; h[a]=1; h[b]=2; p h.size; p h[a]',
    '1\n2\n',
  ],
  ['index receiver before index locals', '(a = [0])[a.size - 1] = 7; p a', '[7]\n'],
  [
    'escaped bytes through interpolation',
    String.raw`p "\xFF#{1}é"; p "\xFF#{1}é".bytes`,
    '"\\xFF1é"\n[255, 49, 195, 169]\n',
  ],
  [
    'escaped bytes through concatenation and repetition',
    String.raw`p ("\xFF" + "a").bytes; p ("\xFF" * 2).bytes`,
    '[255, 97]\n[255, 255]\n',
  ],
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
  ['auto-detected integer radix', 'p Integer("0x10",0), "0b101".to_i(0), "077".to_i(0)', '16\n5\n63\n'],
  ['alternate hexadecimal Float points', 'p format("%#a", 1.0), format("%#.0a", 0.0)', '"0x1.p+0"\n"0x0.p+0"\n'],
  ['zero without alternate integer prefixes', 'p format("%#x",0), format("%#b",0)', '"0"\n"0"\n'],
  ['infinite numeric Range size', 'p (1..Float::INFINITY).size, (1..-Float::INFINITY).size', 'Infinity\n0\n'],
  ['beginless Range maximum', 'p (..3).max, (...3).max', '3\n2\n'],
  ['Set count with numeric equality', 'p Set[1].count(1.0)', '1\n'],
  ['String sum width', 'p "abc".sum(8), "abc".sum(0)', '38\n294\n'],
  ['NUL in whitespace split', String.raw`p "a\u0000 b".split(" ")`, '["a\\u0000", "b"]\n'],
  ['negative format precision', 'p format("%.*s", -1, "abcd")', '"abcd"\n'],
  ['array clearing during deletion', 'a=[1,2,3]; a.delete_if { |x| a.clear if x==2; x==1 }; p a', '[2]\n'],
  [
    'Set insertion during iteration',
    's=Set[1]; begin; s.each { |x| s.add(2) }; rescue => e; puts e.message; end; p s',
    "can't add a new item into set during iteration\nSet[1]\n",
  ],
  ['empty frozen String bang operations', 's="".freeze; p s.delete!("x"), s.tr!("x","y")', 'nil\nnil\n'],
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
  expect(run('[3,1,2].inject')).toMatchObject({
    uncaughtException: 'wrong number of arguments (given 0, expected 1..2) (ArgumentError)',
  });
});

test('an out-of-range percent character raises a Ruby error', () => {
  expect(run('format("%c", 1114112)')).toMatchObject({ uncaughtException: 'invalid character (ArgumentError)' });
});

test('mixing numbered and unnumbered format arguments raises a Ruby error', () => {
  expect(run('format("%d %1$d",1,2)')).toMatchObject({
    uncaughtException: 'numbered(1) after unnumbered(1) (ArgumentError)',
  });
  expect(run('format("%1$d %d",1,2)')).toMatchObject({
    uncaughtException: 'unnumbered(1) mixed with numbered (ArgumentError)',
  });
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

test('a block return from an active class body raises a Ruby error', () => {
  expect(run('class Foo; [1].each { return }; end; puts "after"')).toMatchObject({
    uncaughtException: 'unexpected return (LocalJumpError)',
    stdout: '',
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
    'a custom key matching an Integer hash',
    'class K; def hash = 1.hash; def eql?(x) = x == 1; end; h = {1 => 42}; p h[K.new]',
    '42\n',
  ],
  [
    'a custom key matching a String hash',
    'class K; def hash = "a".hash; def eql?(x) = x == "a"; end; h = {"a" => 42}; p h[K.new]',
    '42\n',
  ],
  [
    'an Array of a custom key matching an Integer Array',
    'class K; def hash = 1.hash; def eql?(x) = x == 1; end; h = {[1] => 42}; p h[[K.new]]',
    '42\n',
  ],
  [
    'an Array of a custom key matching a nested Array',
    'class K; def hash = [1].hash; def eql?(x) = x == [1]; end; h = {[[1]] => 42}; p h[[K.new]]',
    '42\n',
  ],
  [
    'a String subclass kept as a key',
    'class S < String; end; s = S.new("a"); h = {s => 1}; k = h.keys[0]; p k.class, k.equal?(s), k.frozen?',
    'S\ntrue\nfalse\n',
  ],
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
  ['yield with a block argument', 'def f;yield(&proc{});end;f{puts :hit}'],
  ['break with a block argument', '[1].each{break(&proc{})}'],
  ['next with a block argument', '[1].each{next(&proc{})}'],
  ['return with a block argument', 'def f;return(&proc{});end;f'],
  ['else without rescue', 'begin\n  1\nelse\n  2\nend'],
  ['a lowercase class name', 'class foo; end'],
  ['a command call as an operand', 'p 1 && p 2'],
  ['an argument that is a return', 'p((return))'],
  ['an argument that is a rightward pattern match', 'p((5 => x))'],
  ['an assigned rightward pattern match', 'y = (1; 5 => x)'],
  ['a condition that is a rightward pattern match', 'if (5 => x) then 1 end'],
  ['a receiver that is a rightward pattern match', '(5 => x).to_s'],
  ['a left operand that is a rightward pattern match', '(5 => x) && 1'],
  ['an unparenthesized in as an argument', 'p(5 in Integer)'],
  ['a case without clauses', 'case 1\nend'],
  ['a one-line case/in whose in tests the subject', 'case 1 in Integer then p 1 end'],
  ['Unicode escape as a control operand', String.raw`p "\C-\u0041".bytes`],
  ['Unicode escape as a meta operand', String.raw`p "\M-\u0041".bytes`],
])('%s is a compile error', (_name, program) => {
  expect(run(program).kind).toBe('compileError');
});

test.each([
  ['an imaginary number', 'p 2i', '虚数のリテラル'],
  ['an external command', 'p `ls`', '外部コマンドの実行'],
])('%s is refused before running', (_name, program, feature) => {
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
  [
    'instance_eval with a string',
    '1.instance_eval("1")',
    '文字列の評価（instance_eval）は、この採点環境では使えません。',
  ],
  ['a fiber', 'Fiber.new { }', 'Fiber は、この採点環境では使えません。'],
  ['binding', 'binding', 'binding は、この採点環境では使えません。'],
])(
  '%s stops the program with the unsupported-feature message, which rescue cannot catch',
  (_name, program, message) => {
    const execution = run(`puts "before"\nbegin\n  ${program}\nrescue Exception\n  puts "rescued"\nend`);
    expect(execution).toMatchObject({ kind: 'executed', stdout: 'before\n', uncaughtException: message });
  }
);

// Ruby 4.0.9 accepts each of these, with the output shown.
test.each([
  ['a parenthesized in as an argument', 'p((5 in Integer))', 'true\n'],
  ['a rightward pattern match as a statement', '(5 => x)\np x', '5\n'],
  ['a rightward pattern match on the right of &&', 'y = 1 && (5 => x)\np [x, y]', '[5, nil]\n'],
  ['a rightward pattern match before a rescue clause', 'p(begin; 5 => x; rescue; end)', 'nil\n'],
  [
    'a one-line case/in whose subject is the in',
    'x = case 1 in String\nin true then "t"\nin false then "f"\nend\np x',
    '"f"\n',
  ],
])('%s runs', (_name, program, stdout) => {
  const execution = run(program);
  expect(execution.kind).toBe('executed');
  if (execution.kind === 'executed') expect(execution.stdout).toBe(stdout);
});

test('a class Ruby defines as a module cannot be defined as a class', () => {
  expect(run('class Signal\nend')).toMatchObject({ uncaughtException: 'Signal is not a class (TypeError)' });
});

test('Array extrema report comparison operands in Ruby order', () => {
  expect(run('begin; [1, nil].max; rescue => e; puts e.message; end')).toMatchObject({
    stdout: 'comparison of Integer with nil failed\n',
  });
  expect(run('begin; [nil, 1].min; rescue => e; puts e.message; end')).toMatchObject({
    stdout: 'comparison of NilClass with 1 failed\n',
  });
  expect(run('p [[1, :x], [1, :y]].max { |a, b| a[0] > b[0] ? 1 : -1 }')).toMatchObject({
    stdout: '[1, :x]\n',
  });
  expect(run('p [1, 2, 3].max { |a, b| p [a, b]; a <=> b }')).toMatchObject({
    stdout: '[2, 1]\n[3, 2]\n3\n',
  });
  expect(run('begin; [1, nil].max { |a, b| a <=> b }; rescue => e; puts e.message; end')).toMatchObject({
    stdout: 'comparison of NilClass with 1 failed\n',
  });
  expect(run('begin; [1, nil].sort { |a, b| a <=> b }; rescue => e; puts e.message; end')).toMatchObject({
    stdout: 'comparison of Integer with nil failed\n',
  });
  expect(run('begin; [1, nil].each.minmax; rescue => e; puts e.message; end')).toMatchObject({
    stdout: 'comparison of Integer with nil failed\n',
  });
  expect(run('begin; [1, 2, nil].minmax; rescue => e; puts e.message; end')).toMatchObject({
    stdout: 'comparison of Integer with nil failed\n',
  });
  expect(run('p [3, 1, 2, 5, 4].minmax { |a, b| p [a, b]; a <=> b }')).toMatchObject({
    stdout: '[3, 1]\n[2, 5]\n[2, 1]\n[5, 3]\n[4, 1]\n[4, 5]\n[1, 5]\n',
  });
  expect(run('p [[1, :x], [1, :y], [1, :z]].minmax { |a, b| a[0] > b[0] ? 1 : -1 }')).toMatchObject({
    stdout: '[[1, :z], [1, :y]]\n',
  });
});

test('Comparable equality stops recursive comparisons for the same pair', () => {
  expect(
    run(
      'class P; include Comparable; attr_reader :n; def initialize(n); @n=n; end; def <=>(o); return 0 if self == o; n <=> o.n; end; end; p P.new(1) == P.new(1)'
    )
  ).toMatchObject({
    stdout: 'false\n',
  });
});

test('an endless loop exceeds the operation limit, and endless recursion raises SystemStackError', () => {
  expect(run('loop do\nend')).toEqual({ kind: 'limitExceeded', limit: 'operations' });
  expect(run('def f(n) = f(n + 1)\nf(0)')).toMatchObject({
    uncaughtException: 'stack level too deep (SystemStackError)',
  });
});

test('pretty printing a shared graph is bounded before expanding its output', () => {
  expect(run('a = ["x"]; 25.times { a = [a, a] }; pp a')).toEqual({ kind: 'limitExceeded', limit: 'output' });
  expect(run('s = "x" * 100000; pp Array.new(1000, s)')).toEqual({ kind: 'limitExceeded', limit: 'output' });
});

test('inspecting repeated long Strings stops before expanding the whole result', () => {
  expect(run('a = ["x" * 500000] * 400; p a')).toEqual({ kind: 'limitExceeded', limit: 'storage' });
});

test('clone forwards freeze to its hook and applies the requested state', () => {
  expect(
    run('class P; def initialize_clone(o, freeze: nil); p freeze; super; end; end; p P.new.clone(freeze: true).frozen?')
  ).toMatchObject({
    stdout: 'true\ntrue\n',
  });
  expect(run('p Object.new.freeze.clone(freeze: false).frozen?')).toMatchObject({ stdout: 'false\n' });
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

test.each([
  ['curried zero-arity lambda', 'p (-> { 42 }).curry.call', '42\n'],
  [
    'chunk labels and solo groups',
    'p [1, 1.0].chunk { |x| x }.to_a; p [1, 2].chunk { :_alone }.to_a',
    '[[1, [1, 1.0]]]\n[[:_alone, [1]], [:_alone, [2]]]\n',
  ],
  ['short tail of a large range', 'p (1..10000000).last(1)', '[10000000]\n'],
  ['array conversion in puts', 'class A; def to_ary = [1, 2]; end; puts A.new', '1\n2\n'],
  [
    'printing before a later conversion fails',
    'class A; def to_s = raise "bad"; end; begin; print "before", A.new; rescue; puts "after"; end',
    'beforeafter\n',
  ],
  [
    'writing before a later conversion fails',
    'class A; def to_s = raise "bad"; end; begin; $stdout.write("before", A.new); rescue; puts "after"; end',
    'beforeafter\n',
  ],
  [
    'removing a mutated Set member',
    'a = [1]; s = Set[a]; s.delete_if { |x| x << 2; true }; p s.size, s.to_a',
    '0\n[]\n',
  ],
  ['constant-size powers and shifts', 'p 0 << (10**30), 1 ** (10**30), (-1) ** (10**30), 0 ** 0', '0\n1\n1\n1\n'],
  ['rounding a small integer at large precision', 'p 1.round(-1000000000)', '0\n'],
  ['wide Integer sizes', 'p (2**64).size, (2**100).size', '9\n13\n'],
  ['Numeric subclass Math conversion', 'class A < Numeric; def to_f = 9.0; end; p Math.sqrt(A.new)', '3.0\n'],
  ['escaped control and meta operands', String.raw`p "\C-\?".bytes, "\M-\z".bytes`, '[31]\n[250]\n'],
  ['String byte copies', String.raw`p (-"\xFF").bytes, (+"\xFF".freeze).bytes`, '[255]\n[255]\n'],
  [
    'String conversion in concatenation',
    String.raw`class A; def to_str; "\xFF"; end; end; p ("x" + A.new).bytes`,
    '[120, 255]\n',
  ],
  [
    'String conversion in interpolation',
    String.raw`class A; def to_s; "\xFF"; end; end; p "#{A.new}".bytes`,
    '[255]\n',
  ],
  ['UTF-8 Integer concatenation', 's = ""; s << 233; p s.bytes, s', '[195, 169]\n"é"\n'],
  ['Integer concatenation after an invalid byte', String.raw`p "\xFF".concat(233).bytes`, '[255, 195, 169]\n'],
  [
    'raw bytes in String formatting',
    String.raw`p format("%c", "\xFF").bytes, format("%s", "\xFF").bytes, ("%c" % "\xFF").bytes`,
    '[255]\n[255]\n[255]\n',
  ],
  [
    'raw bytes in format templates',
    String.raw`p format("a\xFF%s", "b").bytes, ("a\xFF%s" % "b").bytes`,
    '[97, 255, 98]\n[97, 255, 98]\n',
  ],
  [
    'raw bytes in insertion and prepend',
    String.raw`s="\xFF"; s.prepend("a"); s.insert(1,"b"); p s.bytes`,
    '[97, 98, 255]\n',
  ],
  ['raw byte counts from IO', String.raw`p $stderr.write("\xFF")`, '1\n'],
  [
    'Hash distinguishes incompatible String encodings',
    String.raw`a=255.chr; b="\xFF"; h={a=>1,b=>2}; p h.size,h[a],h[b]`,
    '2\n1\n2\n',
  ],
  ['invalid UTF-8 character slicing', String.raw`p "\xFF".chars, "\xFF"[0].bytes`, '["\\xFF"]\n[255]\n'],
  ['invalid UTF-8 character lengths', String.raw`p "a\xFF".chars.map(&:bytesize)`, '[1, 1]\n'],
  [
    'invalid UTF-8 reversal and padding',
    String.raw`p "\xFF".reverse.bytes, "\xFF".ljust(2).bytes`,
    '[255]\n[255, 32]\n',
  ],
  [
    'invalid UTF-8 successor and trimming',
    String.raw`p "\xFF".succ.bytes, "a\xFF".succ.bytes, "\xFF".chomp.bytes, "\xFF".chop.bytes`,
    '[1, 255]\n[98, 255]\n[255]\n[]\n',
  ],
  [
    'invalid UTF-8 slicing and mutation',
    String.raw`s="a\xFF"; p s.slice!(1).bytes, s.bytes; s="a\xFF"; s[1]="b"; p s.bytes; p "a\xFF"["\xFF"]`,
    '[255]\n[97]\n[97, 98]\nnil\n',
  ],
  ['empty whole-string line iteration', 'p "".lines(nil), "".each_line(nil).to_a', '[""]\n[""]\n'],
  [
    'nonpositive cycle without traversal',
    'class C; include Enumerable; def each; puts :each; yield 1; end; end; C.new.cycle(-1) { puts :block }; C.new.cycle(0) { puts :block }; puts :after',
    'after\n',
  ],
  ['endless Float Range steps', 'p (1..).step(1.5) { |x| break x if x > 2 }', '2.5\n'],
  ['large splat into native Array method', 'a = Array.new(200000, 0); b = []; b.push(*a); p b.size', '200000\n'],
  [
    'numbered format widths and precision',
    'p format("%2$*1$d", 4, 12), format("%2$.*1$f", 2, 1.234)',
    '"  12"\n"1.23"\n',
  ],
  [
    'hexadecimal Float maximum rounding',
    'p format("%.1a", Float::MAX), format("%.13a", Float::MAX)',
    '"0x1.0p+1024"\n"0x1.0000000000000p+1024"\n',
  ],
  [
    'hexadecimal rounding near exponent boundaries',
    'p format("%.13a", 1.0.prev_float), format("%.13a", 2.0.prev_float)',
    '"0x1.0000000000000p+0"\n"0x1.0000000000000p+1"\n',
  ],
  [
    'surrogate format bytes',
    'p format("%c", 55296).bytes, format("%c", 57343).bytes',
    '[237, 160, 128]\n[237, 191, 191]\n',
  ],
  ['adjacent surrogate format bytes', 'p format("%c%c", 55296, 56320).bytes', '[237, 160, 128, 237, 176, 128]\n'],
  [
    'Float Range steps at decimal boundaries',
    'p (0.0..0.6).step(0.2).to_a, (0.0..1.2).step(0.2).to_a, (0.3..0.9).step(0.1).to_a',
    '[0.0, 0.2, 0.4, 0.6]\n[0.0, 0.2, 0.4, 0.6000000000000001, 0.8, 1.0, 1.2]\n[0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]\n',
  ],
  [
    'Float Numeric steps at decimal boundaries',
    'p 0.3.step(0.9, 0.1).to_a, 0.0.step(0.6, 0.2).to_a',
    '[0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]\n[0.0, 0.2, 0.4, 0.6]\n',
  ],
  [
    'Float steps for custom arithmetic ranges',
    'class A; attr_reader :n; def initialize(n); @n=n; end; def <=>(o); n <=> o.n; end; def succ; A.new(n+1); end; def +(v); A.new(n+v); end; end; (A.new(0)..A.new(3)).step(1.5) { |x| p x.n }',
    '0\n1.5\n3.0\n',
  ],
  [
    'custom Range arithmetic before each callback',
    'class A; attr_reader :n; def initialize(n); @n=n; end; def <=>(o); n <=> o.n; end; def succ; puts :succ; A.new(n+1); end; def +(v); puts :plus; A.new(n+v); end; end; (A.new(0)..A.new(3)).step(1.5) { |x| p x.n }',
    'plus\n0\nplus\n1.5\nplus\n3.0\n',
  ],
  [
    'custom Range comparison order',
    'class A; attr_reader :n; def initialize(n); @n=n; end; def <=>(o); puts :cmp; n <=> o.n; end; def +(v); puts :plus; A.new(n+v); end; end; (A.new(0)...A.new(2)).step(1) { |x| p x.n }',
    'cmp\ncmp\nplus\ncmp\ncmp\n0\nplus\ncmp\n1\nplus\ncmp\n',
  ],
  [
    'custom Range at an inclusive starting endpoint',
    'class A; def <=>(o); 0; end; def +(x); raise "bad"; end; end; a=A.new; (a..a).step(1.5) { puts :yielded }',
    'yielded\n',
  ],
  [
    'Unicode case folding',
    'p "ß".casecmp?("ss"), "ﬁ".casecmp?("fi"), "ς".casecmp?("σ"), "İ".casecmp?("i̇")',
    'true\ntrue\ntrue\ntrue\n',
  ],
  [
    'lazy slice_when Enumerator',
    'e = [1, 2, 4].slice_when { |a, b| puts :test; b != a + 1 }; p e.class, e.size; p e.to_a',
    'Enumerator\nnil\ntest\ntest\n[[1, 2], [4]]\n',
  ],
  [
    'chunk_while Enumerator',
    'e = [1, 2, 4].chunk_while { |a, b| b == a + 1 }; p e.class, e.size, e.to_a',
    'Enumerator\nnil\n[[1, 2], [4]]\n',
  ],
])('%s matches Ruby output', (_name, program, stdout) => {
  expect(run(program)).toMatchObject({ kind: 'executed', stdout, uncaughtException: undefined });
});

test('invalid radices and extreme rounding return Ruby errors', () => {
  expect(run('p Integer("0", 37, exception: false)')).toMatchObject({
    uncaughtException: 'invalid radix 37 (ArgumentError)',
  });
  expect(run('p 1.round(-(10**30))')).toMatchObject({
    uncaughtException: "bignum too big to convert into 'long' (RangeError)",
  });
  expect(run('p 1.0.remainder(0.0)')).toMatchObject({
    uncaughtException: 'divided by 0 (ZeroDivisionError)',
  });
  expect(run('p (1.0..3.0).last(0)')).toMatchObject({
    uncaughtException: "can't iterate from Float (TypeError)",
  });
  for (const program of ['p Integer("1", 10**30)', 'p "1".to_i(10**30)', 'p format("%c", -(10**30))']) {
    expect(run(program)).toMatchObject({ uncaughtException: "bignum too big to convert into 'long' (RangeError)" });
  }
  expect(run('p Integer("1", 2147483648)')).toMatchObject({
    uncaughtException: "integer 2147483648 too big to convert to 'int' (RangeError)",
  });
  expect(run('p (...3.0).max')).toMatchObject({
    uncaughtException: 'cannot exclude non Integer end value (TypeError)',
  });
  expect(run('p (..."z").max')).toMatchObject({
    uncaughtException: 'cannot get the maximum of beginless range with custom comparison method (RangeError)',
  });
  expect(run('p [1, 2].inject')).toMatchObject({
    uncaughtException: 'wrong number of arguments (given 0, expected 1..2) (ArgumentError)',
  });
  expect(run('p [1, 2].inject(1, :+, 3)')).toMatchObject({
    uncaughtException: 'wrong number of arguments (given 3, expected 1..2) (ArgumentError)',
  });
  expect(run('p "".tr_s!("a", 2)')).toMatchObject({
    uncaughtException: 'no implicit conversion of Integer into String (TypeError)',
  });
  expect(run('p (255.chr + "é").bytes')).toMatchObject({
    uncaughtException: 'incompatible character encodings: BINARY (ASCII-8BIT) and UTF-8 (Encoding::CompatibilityError)',
  });
  expect(run('s = 255.chr; s << 256')).toMatchObject({
    uncaughtException: '256 out of char range (RangeError)',
  });
  expect(run('class A; def to_s; 255.chr; end; end; p "é#{A.new}"')).toMatchObject({
    uncaughtException: 'incompatible character encodings: UTF-8 and BINARY (ASCII-8BIT) (Encoding::CompatibilityError)',
  });
  expect(run('p format("%{a} %p", {a: 1})')).toMatchObject({
    uncaughtException: 'unnumbered(1) mixed with named (ArgumentError)',
  });
  expect(run('p format("%p %{a}", {a: 1})')).toMatchObject({
    uncaughtException: 'named{a} after unnumbered(1) (ArgumentError)',
  });
});

test('unsupported conversion cannot be hidden with exception false', () => {
  expect(run('class A; def to_int; Thread; end; end; p Integer(A.new, exception: false)')).toMatchObject({
    uncaughtException: 'スレッド（Thread）は、この採点環境では使えません。',
  });
});

test('numeric conversions reject a wrong type returned by a conversion method', () => {
  expect(run('class A; def to_i = "x"; end; p Integer(A.new)')).toMatchObject({
    uncaughtException: "can't convert A to Integer (A#to_i gives String) (TypeError)",
  });
  expect(run('class A; def to_f = "x"; end; p Float(A.new)')).toMatchObject({
    uncaughtException: "can't convert A to Float (A#to_f gives String) (TypeError)",
  });
});

test('invalid UTF-8 raises Ruby character-operation errors', () => {
  for (const program of [String.raw`p "\xFF".ord`, String.raw`p "\xFF".split("")`, String.raw`p "\xFF".count("a")`]) {
    expect(run(program)).toMatchObject({ uncaughtException: 'invalid byte sequence in UTF-8 (ArgumentError)' });
  }
  expect(run(String.raw`p "\xFF".upcase`)).toMatchObject({
    uncaughtException: 'input string invalid (ArgumentError)',
  });
  expect(run(String.raw`p "\xFF".rstrip`)).toMatchObject({
    uncaughtException: 'invalid byte sequence in UTF-8 (Encoding::CompatibilityError)',
  });
});

test('custom Hash key hashes require an Integer-convertible result', () => {
  expect(run('class K; def hash = "x"; end; h = {}; h[K.new] = 1')).toMatchObject({
    uncaughtException: 'no implicit conversion of String into Integer (TypeError)',
  });
  expect(run('class K; def hash = nil; end; h = {}; h[K.new] = 1')).toMatchObject({
    uncaughtException: 'no implicit conversion of nil into Integer (TypeError)',
  });
  expect(
    run('class H; def to_int = 7; end; class K; def hash = H.new; end; h = {}; k = K.new; h[k] = 1; p h[k]')
  ).toMatchObject({
    stdout: '1\n',
  });
});

test('Hash conversion and rehash callbacks keep Ruby error boundaries', () => {
  expect(run('class A; def to_ary = nil; end; p({a: 1}.to_h { A.new })')).toMatchObject({
    uncaughtException: 'wrong element type A (expected array) (TypeError)',
  });
  expect(run('class A; def to_ary = [1]; end; p({a: 1}.to_h { A.new })')).toMatchObject({
    uncaughtException: 'element has wrong array length (expected 2, was 1) (ArgumentError)',
  });
  expect(run('h = {a: 1}; h.each { h.freeze; begin; h.rehash; rescue => e; p e.class; end }')).toMatchObject({
    stdout: 'RuntimeError\n',
  });
});

test('Math and Integer preserve nonfinite signs and small wide bit slices', () => {
  expect(run('p Math.lgamma(Float::INFINITY), Math.lgamma(Float::NAN)')).toMatchObject({
    stdout: '[Infinity, 1]\n[NaN, 1]\n',
  });
  expect(run('p 5[0, 32000001], 5[1..32000001], (-1).fdiv(2**1075), 1.fdiv(-(2**1075))')).toMatchObject({
    stdout: '5\n2\n-0.0\n-0.0\n',
  });
});

test('Random subclasses retain native state without calling super', () => {
  expect(
    run(
      'class R < Random; def initialize(x); @n = x; end; end; r = R.new(7); p r.seed.is_a?(Integer), r.rand.is_a?(Float)'
    )
  ).toMatchObject({
    stdout: 'true\ntrue\n',
  });
});

test('print observes scoped last-line values and passes raw values to replacement writers', () => {
  expect(run('$_ = "a"; def f; $_ = "b"; print; end; f; print')).toMatchObject({ stdout: 'ba' });
  expect(
    run('class W; def write(x); $v << x; end; end; $v = []; $_ = 7; $stdout = W.new; print; $stdout = STDOUT; p $v')
  ).toMatchObject({
    stdout: '[7]\n',
  });
  expect(
    run('class W; def write(x); $v << x; end; end; $v = []; $stdout = W.new; print; $stdout = STDOUT; p $v')
  ).toMatchObject({
    stdout: '[nil]\n',
  });
  expect(run('begin; $, = 1; rescue => e; p e.class; end; print "a", "b"')).toMatchObject({ stdout: 'TypeError\nab' });
  expect(run(String.raw`begin; $\ = 1; rescue => e; p e.class; end; print "a"`)).toMatchObject({
    stdout: 'TypeError\na',
  });
});

test('begin rescue and ensure enforce Ruby value-position rules', () => {
  expect(run('def f; p(begin; return 2; rescue; 1; end); end; p f')).toMatchObject({ stdout: '2\n' });
  expect(run('def f; p(begin; 1; ensure; return 2; end); end; p f').kind).toBe('compileError');
  expect(run('def f; p(begin; return 2; ensure; 1; end); end; p f').kind).toBe('compileError');
});

test('Kernel putc delegates to replacement stream methods and returns their result', () => {
  expect(
    run('class W; def write(x); end; def putc(x); 99; end; end; $stdout=W.new; x=putc(65); $stdout=STDOUT; p x')
  ).toMatchObject({
    stdout: '99\n',
  });
  expect(
    run(
      'class W; def write(x); $v<<[:write,x]; end; private; def putc(x); $v<<[:putc,x]; nil; end; end; $v=[]; $stdout=W.new; x=putc(65); $stdout=STDOUT; p x, $v'
    )
  ).toMatchObject({
    stdout: 'nil\n[[:putc, 65]]\n',
  });
});

test('input record separator stores a frozen copy', () => {
  expect(run('p $/.frozen?; begin; $/ << "x"; rescue => e; p e.class; end')).toMatchObject({
    stdout: 'true\nFrozenError\n',
  });
  expect(run('s="x"; $/=s; s<<"y"; p $/.frozen?, $/')).toMatchObject({ stdout: 'true\n"x"\n' });
  expect(run('$/="x"; begin; $/ << "y"; rescue => e; p e.class; end')).toMatchObject({
    stdout: 'FrozenError\n',
  });
});

test('ArithmeticSequence accessors retain stored Integer types across Float limits', () => {
  expect(
    run('p 1.step(2.5, 1).first, (1..5.0).step(2).first, 1.step(Float::NAN, 2).first, 1.step(5, Float::INFINITY).first')
  ).toMatchObject({
    stdout: '1\n1\n1\n1\n',
  });
  expect(
    run('p 1.step(2.5, 1).first(2), (1..10.0).step(3).last, (1..10.0).step(3).last(2), (1...10.0).step(3).last')
  ).toMatchObject({
    stdout: '[1.0, 2.0]\n10\n[7, 10]\n7\n',
  });
  expect(run('p (10**400).step(Float::NAN, 1).first.class')).toMatchObject({ stdout: 'Integer\n' });
});

test('String successor carries across multibyte letters and skipped symbols', () => {
  expect(run('p "é😀9".succ, "é.9".succ, "ｚ😀9".succ, "日😀9".succ, "a😀9".succ, "ß😀z".succ')).toMatchObject({
    stdout: '"ê😀0"\n"ê.0"\n"ａａ😀0"\n"旦😀0"\n"a😀10"\n"à😀a"\n',
  });
});

test('Range last zero traverses custom successor callbacks', () => {
  expect(
    run(
      'class A; attr_reader :n; def initialize(n); @n=n; end; def <=>(o); @n<=>o.n; end; def succ; raise "bad"; end; end; begin; p (A.new(0)..A.new(3)).last(0); rescue => e; p e.class; end'
    )
  ).toMatchObject({
    stdout: 'RuntimeError\n',
  });
  expect(run('p (1..3).last(0), (1..3).last(2)')).toMatchObject({ stdout: '[]\n[2, 3]\n' });
});

test('Range first zero validates its endpoints', () => {
  expect(run('begin; p (1.0..3.0).first(0); rescue => e; p e.class; end')).toMatchObject({
    stdout: 'TypeError\n',
  });
  expect(run('p (1..3).first(0), (1..3).first(2)')).toMatchObject({ stdout: '[]\n[1, 2]\n' });
});

test('String bounds errors retain exact long indexes', () => {
  for (const source of [
    '"a".insert(9007199254740993, "x")',
    's="a"; s[9007199254740993]="x"',
    's="a"; s[9007199254740993,1]="x"',
  ]) {
    expect(run(`begin; ${source}; rescue => e; p e.message; end`)).toMatchObject({
      stdout: '"index 9007199254740993 out of string"\n',
    });
  }
});

test('String mutation converts out-of-range indexes once', () => {
  for (const source of ['"a".insert(I.new, "x")', 's="a"; s[I.new]="x"', 's="a"; s[I.new,1]="x"']) {
    expect(run(`class I; def to_int; puts :convert; 2; end; end; begin; ${source}; rescue; end`)).toMatchObject({
      stdout: 'convert\n',
    });
  }
});

test('ArithmeticSequence last reports FloatDomainError for overflowing mixed bounds', () => {
  for (const source of ['(10**400).step(1.0, 3).last', '(10**400).step(1.0, 3).last(2)']) {
    expect(run(`p ${source}`)).toMatchObject({ uncaughtException: '-Infinity (FloatDomainError)' });
  }
  expect(run('p (-(10**400)).step(1.0, 3).last')).toMatchObject({
    uncaughtException: 'Infinity (FloatDomainError)',
  });
});

test('ArithmeticSequence last errors name the nonfinite ratio', () => {
  for (const source of ['Float::INFINITY.step(1.0, 1).last', 'Float::INFINITY.step(1, 1).last(2)']) {
    expect(run(`p ${source}`)).toMatchObject({ uncaughtException: '-Infinity (FloatDomainError)' });
  }
  expect(run('p (-Float::INFINITY).step(1.0, 1).last')).toMatchObject({
    uncaughtException: 'Infinity (FloatDomainError)',
  });
  expect(run('p (10**400).step(Float::INFINITY, 0.5).last')).toMatchObject({
    uncaughtException: 'NaN (FloatDomainError)',
  });
});

test('equal Sets hash independently of deleted collision slots', () => {
  expect(
    run(
      'class K; attr_reader :n; def initialize(n); @n=n; end; def hash; 0; end; def eql?(o); n==o.n; end; end; a=(0..10).map { |n| K.new(n) }; x=Set.new(a); 10.times { |i| x.delete(a[i]) }; y=Set[a[10]]; p x.eql?(y), x.hash==y.hash, {x=>42}[y]'
    )
  ).toMatchObject({
    stdout: 'true\ntrue\n42\n',
  });
});

test('Set mapping callbacks reject insertion during iteration', () => {
  for (const method of ['map!', 'classify']) {
    expect(
      run(`s=Set[1,2]; begin; s.${method} { |x| s.add(3) if x==1; x }; rescue => e; p e.class, e.message; end; p s`)
    ).toMatchObject({
      stdout: 'RuntimeError\n"can\'t add a new item into set during iteration"\nSet[1, 2]\n',
    });
  }
});

test('Set hash callbacks reject insertion during iteration', () => {
  expect(
    run(
      'class K; attr_accessor :a; def hash; $s.add(3) if @a; 0; end; end; k=K.new; $s=Set[k]; k.a=true; begin; p $s.hash; rescue => e; p e.class, e.message; end; p $s.size'
    )
  ).toMatchObject({
    stdout: 'RuntimeError\n"can\'t add a new item into set during iteration"\n1\n',
  });
});

test('Set mapping completes when its callback freezes the receiver', () => {
  expect(run('s=Set[1,2]; s.map! { |x| s.freeze; x+1 }; p s, s.frozen?')).toMatchObject({
    stdout: 'Set[2, 3]\ntrue\n',
  });
});

test('puts sends recursive array markers and newlines in separate writes', () => {
  expect(
    run('class W; def write(x); $v << x; end; end; $v=[]; $stdout=W.new; a=[]; a<<a; puts a; $stdout=STDOUT; p $v')
  ).toMatchObject({
    stdout: '["[...]", "\\n"]\n',
  });
});

test('Kernel putc uses write for collectors inheriting Kernel putc', () => {
  expect(
    run('class W; def write(x); $v << x; end; end; $v=[]; $stdout=W.new; x=putc(65); $stdout=STDOUT; p x, $v')
  ).toMatchObject({
    stdout: '65\n["A"]\n',
  });
});

test('Array slice assignment accepts large replacements within storage limits', () => {
  expect(run('a=[]; a[0,0]=Array.new(490000,1); p a.size, a[0], a[-1]')).toMatchObject({
    stdout: '490000\n1\n1\n',
  });
  expect(run('a=[0]; a[0..0]=Array.new(490000,2); p a.size, a[0], a[-1]')).toMatchObject({
    stdout: '490000\n2\n2\n',
  });
});

test('Array deletion respects receiver changes from equality callbacks', () => {
  expect(run('class A; def ==(x); $a.clear; true; end; end; $a=[A.new,2,3]; $a.delete(0); p $a')).toMatchObject({
    stdout: '[]\n',
  });
  expect(run('class A; def ==(x); $a.replace([8]); true; end; end; $a=[A.new,2,3]; $a.delete(0); p $a')).toMatchObject({
    stdout: '[]\n',
  });
});

test('Array conversion callbacks cannot mutate frozen receivers', () => {
  expect(
    run(
      'class X;def to_ary;$a.freeze;[1];end;end;class A<Array;def initialize;$a=self;super(X.new);end;end;begin;A.new;rescue=>e;p e.class;end;p $a'
    )
  ).toMatchObject({
    stdout: 'FrozenError\n[]\n',
  });
  expect(
    run('class I;def to_int;$a.freeze;0;end;end;$a=[1];begin;$a[I.new]=9;rescue=>e;p e.class;end;p $a')
  ).toMatchObject({
    stdout: 'FrozenError\n[1]\n',
  });
});

test('Array slice assignment resolves negative starts after replacement conversion', () => {
  expect(
    run('class X;def to_ary;$a.clear;[9];end;end;$a=[1,2,3];begin;$a[-1,1]=X.new;rescue=>e;p e.class;end;p $a')
  ).toMatchObject({
    stdout: 'IndexError\n[]\n',
  });
});

test('Array shift and slice reject freezing during selector conversion', () => {
  expect(
    run('class I;def to_int;$a.freeze;1;end;end;$a=[1,2,3];begin;$a.shift(I.new);rescue=>e;p e.class;end;p $a')
  ).toMatchObject({
    stdout: 'FrozenError\n[1, 2, 3]\n',
  });
  expect(
    run('class I;def to_int;$a.freeze;0;end;end;$a=[1,2,3];begin;$a.slice!(I.new);rescue=>e;p e.class;end;p $a')
  ).toMatchObject({
    stdout: 'FrozenError\n[1, 2, 3]\n',
  });
});

test('Array insert preserves exact long index errors', () => {
  expect(run('begin;[1].insert(-9007199254740993,9);rescue=>e;p e.message;end')).toMatchObject({
    stdout: '"index -9007199254740993 too small for array; minimum: -2"\n',
  });
  expect(run('begin;[1].insert(9223372036854775807,9);rescue=>e;p e.class;end')).toMatchObject({
    stdout: 'IndexError\n',
  });
});

test('Array fill checks freezing before expansion and permits block freezing', () => {
  expect(
    run('class I;def to_int;$a.freeze;3;end;end;$a=[1];begin;$a.fill(9,I.new,1);rescue=>e;p e.class;end;p $a')
  ).toMatchObject({
    stdout: 'FrozenError\n[1]\n',
  });
  expect(run('$a=[1,2];$a.fill{|i|$a.freeze;9};p $a')).toMatchObject({ stdout: '[9, 9]\n' });
});

test('Array set operators require one operand', () => {
  expect(run('begin;[1].-;rescue=>e;p e.class;end;begin;[1].|([2],[3]);rescue=>e;p e.class;end')).toMatchObject({
    stdout: 'ArgumentError\nArgumentError\n',
  });
});

test('Array set operations use eql without hashing small operands', () => {
  const source = `class K
  def hash; raise 'hash called'; end
  def eql?(other); true; end
end
a=K.new;b=K.new
p ([a]-[b]).size,([a]&[b]).size,([a]|[b]).size
p [a,a].intersection.size
p ([a]*16-[b]).size,([a]*16&[b]).size
begin; [a]*17&[b]; rescue=>e; p e.message; end`;
  expect(run(source)).toMatchObject({ stdout: '0\n1\n1\n2\n0\n1\n"hash called"\n' });
});

test('Array intersect predicate compares small operands without hashing', () => {
  expect(
    run('class K;def hash;raise "hashed";end;def eql?(v);false;end;end;p [K.new].intersect?([K.new])')
  ).toMatchObject({
    stdout: 'false\n',
  });
});

test('Array intersection operator follows receiver edits during equality callbacks', () => {
  const source = 'class K;def eql?(x);$a.clear;false;end;end;$a=[K.new,2];p ($a & [1,2]),$a';
  expect(run(source)).toMatchObject({ stdout: '[]\n[]\n' });
  const named = 'class K;def eql?(x);$a.clear;false;end;end;$a=[K.new,2];p $a.intersection([1,2]),$a';
  expect(run(named)).toMatchObject({ stdout: '[2]\n[]\n' });
});

test('Hash constructor copies stored key hashes without callbacks', () => {
  const source = `class K
  attr_accessor :bad
  def hash; raise 'bad' if @bad; 0; end
end
k=K.new;h={k=>1};k.bad=true
p Hash[h].size
class H;def initialize(h);@h=h;end;private;def to_hash;@h;end;end
p Hash[H.new(h)].size`;
  expect(run(source)).toMatchObject({ stdout: '1\n1\n' });
});

test('Enumerable chunk rejects reserved classifier symbols when consumed', () => {
  expect(run('begin;[1].chunk{|x|:_bad}.to_a;rescue=>e;p e.class,e.message;end')).toMatchObject({
    stdout: 'RuntimeError\n"symbols beginning with an underscore are reserved"\n',
  });
});

test('Array conversions observe current operands and row widths', () => {
  expect(run('class X;def to_ary;$a.replace([[9],[8]]);[1];end;end;$a=[X.new,[2]];p $a.transpose')).toMatchObject({
    stdout: '[[1, 8]]\n',
  });
  expect(
    run('class A;def to_ary;puts :called;[3];end;end;begin;[[1],[2,3],A.new].transpose;rescue=>e;p e.class;end')
  ).toMatchObject({
    stdout: 'IndexError\n',
  });
  expect(run('class X;def to_ary;$b[1]=9;[3];end;end;$b=[1,2];p [0].product($b,X.new)')).toMatchObject({
    stdout: '[[0, 1, 3], [0, 9, 3]]\n',
  });
  expect(run('class A;private;def to_ary;[1,2];end;end;p [A.new].assoc(1),[A.new].rassoc(2)')).toMatchObject({
    stdout: '[1, 2]\n[1, 2]\n',
  });
});

test('Array mutation and selection follow callback boundaries', () => {
  expect(run('$a=[3,2,1];p $a.sort_by!{|x|$a.clear if x==3;x},$a')).toMatchObject({ stdout: '[3]\n[3]\n' });
  expect(run('class A;def to_ary;$a.clear;[];end;end;$a=[A.new];p $a.flatten!.equal?($a)')).toMatchObject({
    stdout: 'true\n',
  });
  expect(run('begin;[1].repeated_combination(4294967296){break};rescue=>e;p e.class;end')).toEqual({
    kind: 'limitExceeded',
    limit: 'storage',
  });
  expect(run('begin;[1].repeated_permutation(4294967296){break};rescue=>e;p e.class;end')).toEqual({
    kind: 'limitExceeded',
    limit: 'storage',
  });
  expect(run('begin;[1,2].sample(random:Random.new(1),foo:2);rescue=>e;p e.class;end')).toMatchObject({
    stdout: 'ArgumentError\n',
  });
  expect(run('begin;[1,2].shuffle(3);rescue=>e;p e.class;end')).toMatchObject({ stdout: 'ArgumentError\n' });
});

test('shuffle permits same-length receiver edits and rejects size changes', () => {
  expect(
    run('class R;def rand(n);$a.replace([8,9,10]);0;end;end;$a=[1,2,3];p $a.shuffle!(random:R.new),$a')
  ).toMatchObject({
    stdout: '[9, 8, 10]\n[9, 8, 10]\n',
  });
  expect(
    run('class R;def rand(n);$a.clear;0;end;end;$a=[1,2,3];begin;$a.shuffle!(random:R.new);rescue=>e;p e.class;end')
  ).toMatchObject({
    stdout: 'RuntimeError\n',
  });
  expect(
    run(
      'class R;def rand(n);$a<<9;0;end;end;$a=[1,2,3];begin;$a.shuffle!(random:R.new);rescue=>e;p e.class,e.message;end;p $a'
    )
  ).toMatchObject({ stdout: 'RuntimeError\n"modified during shuffle"\n[1, 2, 3, 9]\n' });
  expect(
    run('class R;def rand(n);$a.pop;0;end;end;$a=[1,2,3];begin;$a.shuffle!(random:R.new);rescue=>e;p e.class;end;p $a')
  ).toMatchObject({ stdout: 'RuntimeError\n[1, 2]\n' });
});

test('Hash initialization validates frozen state and capacity conversion', () => {
  expect(
    run(
      'class H<Hash;def reset(v);initialize(v);end;end;h=H.new(1);h.freeze;begin;h.reset(9);rescue=>e;p e.class;end;p h[:x]'
    )
  ).toMatchObject({
    stdout: 'FrozenError\n1\n',
  });
  expect(run('class I;private;def to_int;puts :convert;2;end;end;p Hash.new(capacity:I.new)')).toMatchObject({
    stdout: 'convert\n{}\n',
  });
  expect(run('begin;Hash.new(capacity:10**30);rescue=>e;p e.class;end')).toMatchObject({ stdout: 'RangeError\n' });
  expect(run('begin;Hash.new(capacity:nil);rescue=>e;p e.message;end')).toMatchObject({
    stdout: '"no implicit conversion from nil to integer"\n',
  });
  expect(
    run(
      'begin;Hash.new(capacity:Float::NAN);rescue=>e;p e.class,e.message;end;begin;Hash.new(capacity:9223372036854775808.0);rescue=>e;p e.class,e.message;end'
    )
  ).toMatchObject({
    stdout:
      'RangeError\n"float NaN out of range of integer"\nRangeError\n"float 9.223372037e+18 out of range of integer"\n',
  });
});

test('Array reads current contents after conversion callbacks', () => {
  expect(run('class X;def to_ary;$a.clear;[9];end;end;$a=[1,2];b=$a+X.new;p b,$a')).toMatchObject({
    stdout: '[9]\n[]\n',
  });
  expect(run('class I;def to_int;$a.replace([8,9]);1;end;end;$a=[1,2,3];p $a.rotate(I.new),$a')).toMatchObject({
    stdout: '[9, 8]\n[8, 9]\n',
  });
  expect(run('class X;def to_ary;$a.replace([8]);[9];end;end;$a=[X.new,2,3];p $a.flatten,$a')).toMatchObject({
    stdout: '[9]\n[8]\n',
  });
});

test('Array mutation callbacks respect receiver freezing', () => {
  expect(run('$a=[2,1];begin;$a.map!{|x|$a.freeze;x+1};rescue=>e;p e.class;end;p $a')).toMatchObject({
    stdout: 'FrozenError\n[2, 1]\n',
  });
  expect(run('$a=[2,1];begin;$a.sort!{|x,y|$a.freeze;x<=>y};rescue=>e;p e.class;end;p $a')).toMatchObject({
    stdout: 'FrozenError\n[2, 1]\n',
  });
});

test('Enumerable uniq interleaves callbacks and hashes keys once', () => {
  expect(
    run('class E;include Enumerable;def each;puts :before;yield 1;puts :after;end;end;E.new.uniq{|x|puts :block;x}')
  ).toMatchObject({
    stdout: 'before\nblock\nafter\n',
  });
  expect(run('class K;def hash;puts :hash;0;end;end;[K.new,K.new].uniq')).toMatchObject({
    stdout: 'hash\nhash\n',
  });
  expect(run('p [1].uniq{puts :block;1}')).toMatchObject({ stdout: '[1]\n' });
});

test('Array uniqueness follows callback replacement', () => {
  expect(run('$a=[1,2,3];p $a.uniq{|x|$a.replace([8]) if x==1;x},$a')).toMatchObject({
    stdout: '[1]\n[8]\n',
  });
  expect(run('$a=[1,2,3];p $a.uniq!{|x|$a.replace([8]) if x==1;x},$a')).toMatchObject({
    stdout: 'nil\n[8]\n',
  });
});

test('Array product and set operations read receivers after operand conversion', () => {
  expect(run('class X;def to_ary;$a.replace([8]);[9];end;end;$a=[1,2];$a.product(X.new){|x|p x}')).toMatchObject({
    stdout: '[8, 9]\n',
  });
  expect(run('class X;def to_ary;$a.replace([8]);[9];end;end;$a=[1,2];p $a|X.new,$a')).toMatchObject({
    stdout: '[8, 9]\n[8]\n',
  });
});

test('Array equality searches and extrema follow current storage', () => {
  expect(run('class X;def ==(x);$a.clear;false;end;end;$a=[X.new,9];p $a.include?(9),$a')).toMatchObject({
    stdout: 'false\n[]\n',
  });
  expect(run('$a=[3,2,1];p $a.min{|x,y|$a.clear;x<=>y},$a')).toMatchObject({
    stdout: '2\n[]\n',
  });
});

test('Array to_h follows current contents after block callbacks', () => {
  expect(run('$a=[1,2,3];p $a.to_h{|x|$a.clear if x==1;[x,x]}.size,$a')).toMatchObject({
    stdout: '1\n[]\n',
  });
});

test('Hash mutation callbacks cannot write after freezing', () => {
  expect(run('h={a:1,b:2};begin;h.delete_if{|k,v|h.freeze;true};rescue=>e;p e.class;end;p h.size')).toMatchObject({
    stdout: 'FrozenError\n2\n',
  });
  expect(
    run('h={a:1,b:2};begin;h.transform_values!{|v|h.freeze;v+1};rescue=>e;p e.class;end;p h.values')
  ).toMatchObject({
    stdout: 'FrozenError\n[1, 2]\n',
  });
});

test('Hash association searches reject insertion during comparisons', () => {
  expect(
    run('class X;def ==(v);$h[:b]=2;false;end;end;$h={X.new=>1};begin;p $h.assoc(0);rescue=>e;p e.class;end;p $h.size')
  ).toMatchObject({
    stdout: 'RuntimeError\n1\n',
  });
});

test('Hash copy methods do not rehash retained keys', () => {
  expect(
    run(
      'class K;attr_accessor :bad;def hash;raise "bad" if @bad;0;end;end;k=K.new;h={k=>1};k.bad=true;p h.compact.size,h.select{true}.size,h.reject{false}.size'
    )
  ).toMatchObject({
    stdout: '1\n1\n1\n',
  });
});

test('Hash implicit conversions accept private methods and report invalid results', () => {
  expect(run('class A;private;def to_proc;proc{|h,k|7};end;end;h={};h.default_proc=A.new;p h[:x]')).toMatchObject({
    stdout: '7\n',
  });
  expect(run('class A;def to_hash;1;end;end;begin;{}.merge(A.new);rescue=>e;p e.message;end')).toMatchObject({
    stdout: '"can\'t convert A to Hash (A#to_hash gives Integer)"\n',
  });
});

test('Set construction interleaves source and mapping callbacks', () => {
  expect(
    run('class E;include Enumerable;def each;puts :before;yield 1;puts :after;end;end;Set.new(E.new){|x|puts :block;x}')
  ).toMatchObject({
    stdout: 'before\nblock\nafter\n',
  });
});

test('Set union and difference copy stored member hashes', () => {
  expect(
    run(
      'class K;attr_accessor :bad;def hash;raise "bad" if @bad;0;end;end;k=K.new;s=Set[k];k.bad=true;p (s|Set[]).size,(s-Set[]).size'
    )
  ).toMatchObject({
    stdout: '1\n1\n',
  });
});

test('Set inspection rejects insertion during member callbacks', () => {
  expect(
    run('class K;def inspect;$s.add(1);"k";end;end;$s=Set[K.new];begin;p $s.inspect;rescue=>e;p e.class;end;p $s.size')
  ).toMatchObject({
    stdout: 'RuntimeError\n1\n',
  });
});

test('Set comparison and replacement guard active iteration', () => {
  expect(
    run(
      'class K;attr_accessor :on;def hash;$s.add(1) if @on;0;end;end;k=K.new;$s=Set[k];t=Set[k];k.on=true;begin;p $s.subset?(t);rescue=>e;p e.class;end;p $s.size'
    )
  ).toMatchObject({
    stdout: 'RuntimeError\n1\n',
  });
  expect(run('s=Set[1,2];begin;s.each{s.replace(Set[])};rescue=>e;p e.class,e.message;end;p s.size')).toMatchObject({
    stdout: 'RuntimeError\n"cannot replace set during iteration"\n2\n',
  });
});

test('Set subclasses retain their result class', () => {
  expect(
    run('class S<Set;end;s=S[1];p s.class,(s|Set[]).class,(s-Set[]).class,(s&Set[1]).class,s.flatten.class')
  ).toMatchObject({
    stdout: 'S\nS\nS\nS\nS\n',
  });
});

test('Set intersection initializes subclasses without arguments and keeps initialized members', () => {
  expect(
    run(
      'class S<Set;def initialize(x=nil);super([9]);merge(x) if x;end;end;s=S.new([1,2]);p (s & Set[1]).to_a,s.intersection(Set[1]).to_a'
    )
  ).toMatchObject({
    stdout: '[9, 1]\n[9, 1]\n',
  });
  expect(
    run('class S<Set;def initialize(x,y);super(x);end;end;s=S.new([1],2);begin;s & Set[1];rescue=>e;p e.message;end')
  ).toMatchObject({
    stdout: '"wrong number of arguments (given 0, expected 2)"\n',
  });
});

test('Set intersection initializes before iterating the operand', () => {
  const source =
    'class E;include Enumerable;def each;puts :each;raise "bad";end;end;class S<Set;def initialize(*a);puts :init;super(*a);end;end;s=S.new([1]);puts :start;begin;s & E.new;rescue=>e;p e.class;end';
  expect(run(source)).toMatchObject({ stdout: 'init\nstart\ninit\neach\nRuntimeError\n' });
});

test('Set intersection avoids rehashing unrelated receiver members', () => {
  const source =
    'class K;attr_accessor :bad;def hash;raise "bad" if @bad;0;end;end;k=K.new;s=Set[k];k.bad=true;p (s & Set[]).size,(s.intersection(Set[2])).size';
  expect(run(source)).toMatchObject({ stdout: '0\n0\n' });
});

test('Set intersection dispatches overridden membership checks', () => {
  expect(run('class S<Set;def include?(x);puts :inc;true;end;end;s=S[1];p (s & Set[2]).to_a')).toMatchObject({
    stdout: 'inc\n[2]\n',
  });
});

test('Set subclasses use overridden insertion and deletion methods', () => {
  expect(
    run(
      'class S<Set;def add(x);super(x*2);end;end;p S.new([1]).to_a,S.new([1]){|x|x+1}.to_a,S[1].to_a,S.new(Set[1]).to_a'
    )
  ).toMatchObject({
    stdout: '[2]\n[4]\n[2]\n[2]\n',
  });
  expect(
    run('class S<Set;def delete(x);puts :deleted;self;end;end;s=S.new([1]);puts :start;p (s^Set[1]).to_a')
  ).toMatchObject({
    stdout: 'start\ndeleted\n[1]\n',
  });
  expect(run('class S<Set;def add(x);puts :add;super(x*2);end;end;p (S.new|Set[1]).to_a')).toMatchObject({
    stdout: 'add\n[2]\n',
  });
  expect(run('class S<Set;def delete(x);puts :del;super;end;end;p (S[1]-Set[2]).to_a')).toMatchObject({
    stdout: 'del\n[1]\n',
  });
  expect(
    run(
      'class S<Set;def add(x);puts :add;super(x*2);end;def delete(x);puts :del;super;end;end;s=S.new;puts :start;s.merge([1]);s.subtract([2]);p s.to_a'
    )
  ).toMatchObject({
    stdout: 'start\nadd\ndel\n[]\n',
  });
});

test('Set flatten dispatches subclass insertion methods', () => {
  expect(
    run('class S<Set;def add(x);puts :add;super(x*2);end;end;s=S[1];puts :flatten;p s.flatten.to_a')
  ).toMatchObject({
    stdout: 'add\nflatten\nadd\n[4]\n',
  });
  expect(
    run(
      'class S<Set;def add(x);puts :add;super(x.is_a?(Integer) ? x*2 : x);end;end;s=S[Set[1]];puts :start;p s.flatten!.to_a'
    )
  ).toMatchObject({
    stdout: 'add\nstart\nadd\n[2]\n',
  });
});

test('String formatting handles repeated long inputs within the operation limit', () => {
  expect(run('s="x"*100000;10.times{p format("%s",s).size}')).toMatchObject({
    stdout: '100000\n'.repeat(10),
  });
  expect(run('s="x"*100000;p format("%c",s).size,format("%p",s).size')).toMatchObject({
    stdout: '1\n100002\n',
  });
});

test('Random custom ranges retain Float distances and frozen initialization state', () => {
  expect(
    run(
      'class A;def <=>(x);0;end;def -(x);Float::MAX;end;def +(x);p x.class;x;end;end;Random.new(1).rand(A.new..A.new)'
    )
  ).toMatchObject({
    stdout: 'Float\n',
  });
  expect(
    run(
      'class R<Random;def reset;initialize(3);end;end;r=R.new(1).freeze;begin;r.reset;rescue=>e;p e.class;end;p r.seed'
    )
  ).toMatchObject({
    stdout: 'FrozenError\n1\n',
  });
});

test('frozen standard streams reject writes and sync changes', () => {
  expect(
    run('STDERR.freeze;begin;STDERR.write("x");rescue=>e;p e.class;end;begin;STDERR.sync=false;rescue=>e;p e.class;end')
  ).toMatchObject({
    stdout: 'FrozenError\nFrozenError\n',
  });
  expect(
    run(
      'STDERR.freeze;begin;p STDERR.sync;rescue=>e;p e.class;end;begin;p STDERR.tty?;rescue=>e;p e.class;end;begin;p STDERR.isatty;rescue=>e;p e.class;end;p STDERR.fileno'
    )
  ).toMatchObject({
    stdout: 'FrozenError\nFrozenError\nFrozenError\n2\n',
  });
});

test('Random custom ranges convert endpoints after infinite distances', () => {
  const source =
    'class A<Numeric;def initialize(n);@n=n;end;def <=>(x);0;end;def -(x);Float::INFINITY;end;def to_f;@n.to_f;end;def +(x);x;end;end;p Random.new(1).rand(A.new(1)..A.new(2))';
  expect(run(source)).toMatchObject({ stdout: '1.4170219986692967\n' });
  const invalid =
    'class A;def <=>(x);0;end;def -(x);Float::INFINITY;end;def +(x);x;end;end;begin;Random.new(1).rand(A.new..A.new);rescue=>e;p e.class;end';
  expect(run(invalid)).toMatchObject({ stdout: 'TypeError\n' });
});

test('boxed Floats reject singleton classes within Ruby execution', () => {
  expect(
    run(
      'begin;Float::MAX.singleton_class;rescue=>e;p e.class;end;begin;Float::NAN.singleton_class;rescue=>e;p e.class;end'
    )
  ).toMatchObject({
    stdout: 'TypeError\nTypeError\n',
  });
});

test('copied block Procs share the original call lifetime', () => {
  expect(run('def f(&b);b.dup.call;end;p f{break 7}')).toMatchObject({ stdout: '7\n' });
  expect(run('def f(&b);$copy=b.dup;end;f{break 7};begin;$copy.call;rescue=>e;p e.class;end')).toMatchObject({
    stdout: 'LocalJumpError\n',
  });
});

test('Hash conversion tries Array overrides before the empty shortcut', () => {
  expect(run('class Array;def to_hash;{a:1};end;end;p Hash([]),Hash([1])')).toMatchObject({
    stdout: '{a: 1}\n{a: 1}\n',
  });
});

test('keyword forwarding copies stored Hash keys without rehashing', () => {
  const source =
    'class K;def hash;puts :hash;0;end;end;class A;def f(**x);p x.size;end;end;class B<A;def f(**x);x=$h;super;end;end;$h={K.new=>1};puts :start;B.new.f';
  expect(run(source)).toMatchObject({ stdout: 'hash\nstart\n1\n' });
  expect(
    run('class K;def hash;puts :hash;0;end;end;def f(**x);p x.size;end;h={K.new=>1};puts :start;f(**h)')
  ).toMatchObject({
    stdout: 'hash\nstart\n1\n',
  });
});

test('attribute declarations retain earlier names after a later error', () => {
  expect(run('class A;begin;attr_reader :x,1;rescue;end;end;p A.new.x')).toMatchObject({ stdout: 'nil\n' });
});

test('frozen exceptions preserve their message during initialization and copying', () => {
  expect(
    run(
      'class E<StandardError;def reset;initialize("b");end;end;e=E.new("a").freeze;begin;e.reset;rescue=>x;p x.class;end;p e.message'
    )
  ).toMatchObject({
    stdout: 'FrozenError\n"a"\n',
  });
  expect(run('e=RuntimeError.new("a").freeze;begin;e.exception("b");rescue=>x;p x.class;end')).toMatchObject({
    stdout: 'FrozenError\n',
  });
});

test('lambda curry counts keyword slots in explicit bounds', () => {
  expect(run('f=->(x:){};begin;p f.curry(0).class;rescue=>e;p e.class;end;p f.curry(1).class')).toMatchObject({
    stdout: 'ArgumentError\nProc\n',
  });
  expect(run('f=->(x:1){};p f.curry(0).class,f.curry(1).class')).toMatchObject({ stdout: 'Proc\nProc\n' });
});

test('Math logarithms retain very large Integer magnitudes', () => {
  expect(run('p Math.log2(10**400),Math.log10(10**400),Math.log2(2**1024)')).toMatchObject({
    stdout: '1328.771237954945\n400.0\n1024.0\n',
  });
  expect(run('(310..318).each{|n|p Math.log10(10**n)==n.to_f};p Math.log2(10**314)')).toMatchObject({
    stdout: 'true\n'.repeat(9) + '1043.0854217946319\n',
  });
});

test('Hash merge follows source deletions and guards insertion', () => {
  expect(run('h={a:1,b:2};x={a:0}.merge(h){|k,x,y|h.clear;y};p x,h')).toMatchObject({
    stdout: '{a: 1}\n{}\n',
  });
  expect(run('h={a:1};begin;{a:0}.merge(h){|k,x,y|h[:c]=3;y};rescue=>e;p e.class;end')).toMatchObject({
    stdout: 'RuntimeError\n',
  });
});

test('String concat defers encoding-specific bounds until prior compatibility', () => {
  const source =
    'class A;def to_str;puts :convert;"x";end;end;begin;255.chr.concat("é",256,A.new);rescue=>e;p e.class;end';
  expect(run(source)).toMatchObject({ stdout: 'convert\nEncoding::CompatibilityError\n' });
});

test('String line iteration validates every keyword', () => {
  expect(run('begin;"a".lines(chomp:true,foo:1);rescue=>e;p e.class,e.message;end')).toMatchObject({
    stdout: 'ArgumentError\n"unknown keyword: :foo"\n',
  });
  expect(run('begin;"a".each_line(foo:1).to_a;rescue=>e;p e.class;end')).toMatchObject({ stdout: 'ArgumentError\n' });
});

test('numeric option methods validate keywords after recognized options', () => {
  expect(
    run(
      'begin;2.5.round(half: :up,foo:1);rescue=>e;p e.class;end;begin;Integer("12",exception:false,foo:1);rescue=>e;p e.class;end;begin;Float("1",exception:false,foo:1);rescue=>e;p e.class;end'
    )
  ).toMatchObject({
    stdout: 'ArgumentError\n'.repeat(3),
  });
  expect(run('begin;2.5.round(half: :bad,foo:1);rescue=>e;p e.message;end')).toMatchObject({
    stdout: '"unknown keyword: :foo"\n',
  });
});

test('unknown keywords precede rounding and line separator conversions', () => {
  const source =
    'class A;def to_str;puts :called;"up";end;end;begin;2.5.round(half:A.new,foo:1);rescue=>e;p e.class;end';
  expect(run(source)).toMatchObject({ stdout: 'ArgumentError\n' });
  const lines = 'class A;def to_str;puts :called;",";end;end;begin;"a".lines(A.new,foo:1);rescue=>e;p e.message;end';
  expect(run(lines)).toMatchObject({ stdout: '"unknown keyword: :foo"\n' });
});

test('pretty printing deeply nested Arrays stays inside execution limits', () => {
  const source = 'def mk # atomic\n a=1\n 20000.times{a=[a]}\n a\nend\npp mk';
  expect(run(source).kind).toBe('limitExceeded');
  const hashes = 'def mk # atomic\n a=1\n 20000.times{a={x:a}}\n a\nend\npp mk';
  expect(run(hashes).kind).toBe('limitExceeded');
});

test('visibility changes apply before later name conversion errors', () => {
  expect(
    run('class C;def x;1;end;begin;private :x,1;rescue;end;end;begin;p C.new.x;rescue=>e;p e.class;end')
  ).toMatchObject({
    stdout: 'NoMethodError\n',
  });
});

test('String concat validates integers after encoding promotion', () => {
  expect(run('s=255.chr;s.clear;s.concat("é",256);p s.bytes')).toMatchObject({
    stdout: '[195, 169, 196, 128]\n',
  });
});

test('String prefix and suffix predicates check encoding compatibility', () => {
  expect(
    run('begin;255.chr.start_with?("é");rescue=>e;p e.class;end;begin;"é".end_with?(255.chr);rescue=>e;p e.class;end')
  ).toMatchObject({
    stdout: 'Encoding::CompatibilityError\nEncoding::CompatibilityError\n',
  });
});

test('String substitutions preserve mixed UTF-8 and invalid bytes', () => {
  expect(run(String.raw`p "é\xFFa".gsub("a","b").bytes,"é\xFFa".sub("a","b").bytes`)).toMatchObject({
    stdout: '[195, 169, 255, 98]\n[195, 169, 255, 98]\n',
  });
});

test('String character-set operations check argument encodings', () => {
  const source =
    's=255.chr;begin;s.count("é");rescue=>e;p e.class;end;begin;s.delete("é");rescue=>e;p e.class;end;begin;s.squeeze("é");rescue=>e;p e.class;end;begin;("a"+s).tr("a","é");rescue=>e;p e.class;end';
  expect(run(source)).toMatchObject({
    stdout: 'Encoding::CompatibilityError\n'.repeat(4),
  });
  expect(run('s=255.chr;s.clear;s<<"a";p s.tr("a","é").bytes')).toMatchObject({ stdout: '[195, 169]\n' });
});

test('String translation stays bounded for broad character ranges', () => {
  expect(run(String.raw`s="a"*100000;p s.tr("a-\u{ffff}","x").size`)).toMatchObject({ stdout: '100000\n' });
  expect(run(String.raw`s="a"*40000;p s.tr_s("a-\u{ffff}","x").size`)).toMatchObject({ stdout: '1\n' });
});

test('String codepoint iteration yields a valid prefix before invalid bytes', () => {
  expect(run(String.raw`begin;"a\xFF".each_codepoint{|c|p c};rescue=>e;p e.class;end`)).toMatchObject({
    stdout: '97\nArgumentError\n',
  });
  expect(run(String.raw`p "ab\xFF".each_codepoint.first`)).toMatchObject({ stdout: '97\n' });
  expect(run('s="abc";s.each_codepoint{|x|p x;s.clear}')).toMatchObject({ stdout: '97\n' });
  expect(run('s="abc";s.each_codepoint{|x|p x;s<<"d" if x==97}')).toMatchObject({
    stdout: '97\n98\n99\n100\n',
  });
  expect(run('s="x"*100000;10.times{p s.each_codepoint.first}')).toMatchObject({
    stdout: '120\n'.repeat(10),
  });
  expect(run('s="éa";s.each_codepoint{|x|p x;s[0]="bb" if x==233}')).toMatchObject({
    stdout: '233\n97\n',
  });
  expect(run('s="bba";s.each_codepoint{|x|p x;s[0,2]="é" if x==98}')).toMatchObject({
    stdout: '98\n169\n97\n',
  });
  expect(run(String.raw`s="ab";s.each_codepoint{|x|p x;s[1]="\xFF" if x==97}`)).toMatchObject({
    stdout: '97\n255\n',
  });
});

test('String character and byte iterators use their Ruby mutation boundaries', () => {
  expect(run('s="x"*100000;10.times{p s.each_char.first};10.times{p s.ord,s.chr}')).toMatchObject({
    stdout: '"x"\n'.repeat(10) + '120\n"x"\n'.repeat(10),
  });
  expect(run('s="abc";s.each_char{|x|p x;s.clear}')).toMatchObject({ stdout: '"a"\n"b"\n"c"\n' });
  expect(run('s="abc";s.each_byte{|x|p x;s.clear}')).toMatchObject({ stdout: '97\n' });
  expect(run('s="ab";s.each_byte{|x|p x;s<<"c" if x==97}')).toMatchObject({ stdout: '97\n98\n99\n' });
});

test('String translation checks source and replacement pattern encodings', () => {
  expect(
    run('begin;"a".tr(255.chr,"é");rescue=>e;p e.class;end;begin;"a".tr_s(255.chr,"é");rescue=>e;p e.class;end')
  ).toMatchObject({
    stdout: 'Encoding::CompatibilityError\n'.repeat(2),
  });
});

test('String chr keeps the encoding of an empty binary receiver', () => {
  expect(run('s=255.chr;s.clear;t=s.chr;begin;t<<256;rescue=>e;p e.class;end')).toMatchObject({
    stdout: 'RangeError\n',
  });
});

test('Set reinitialization preserves existing members and frozen contents', () => {
  expect(
    run(
      'class S<Set;def reset(x);initialize(x);end;end;s=S[1];s.reset([2]);p s.to_a;s.freeze;begin;s.reset([9]);rescue=>e;p e.class;end;p s.to_a'
    )
  ).toMatchObject({
    stdout: '[1, 2]\nFrozenError\n[1, 2]\n',
  });
});

test('Set subset comparisons stop before impossible member lookups', () => {
  const source =
    'class K;def hash;puts :hash;0;end;end;s=Set[K.new,1];t=Set[];puts :start;p s.subset?(t),t.superset?(s)';
  expect(run(source)).toMatchObject({ stdout: 'hash\nstart\nfalse\nfalse\n' });
});

test('Set replacement reflects yielded members before a source error', () => {
  const source =
    'class E;include Enumerable;def each;yield 2;raise "bad";end;end;s=Set[1];begin;s.replace(E.new);rescue;end;p s.to_a';
  expect(run(source)).toMatchObject({ stdout: '[2]\n' });
});

test('Set classification hashes a new group key once', () => {
  expect(run('class K;def hash;puts :hash;0;end;end;Set[1].classify{|x|K.new}')).toMatchObject({
    stdout: 'hash\n',
  });
});

test('Set size and length reject arguments and ignore blocks', () => {
  expect(run('begin;Set[1,2].size(1);rescue=>e;p e.class;end;p Set[1,2].length{puts :hit;false}')).toMatchObject({
    stdout: 'ArgumentError\n2\n',
  });
});

test('Set add? hashes a new member once and returns nil for existing members', () => {
  expect(
    run('class K;def hash;@n=(@n||0)+1;raise "bad" if @n==2;0;end;end;s=Set[];k=K.new;p s.add?(k).size')
  ).toMatchObject({ stdout: '1\n' });
  expect(run('s=Set[1];p s.add?(1),s.size')).toMatchObject({ stdout: 'nil\n1\n' });
});

test('Set subclass add? dispatches include? and add overrides', () => {
  expect(run('class S<Set;def add(x);puts :add;super(x*2);end;end;s=S[];p s.add?(1).to_a')).toMatchObject({
    stdout: 'add\n[2]\n',
  });
  expect(run('class S<Set;def include?(x);puts :include;true;end;end;s=S[];p s.add?(1)')).toMatchObject({
    stdout: 'include\nnil\n',
  });
});

test('singleton_class returns immediate nil and boolean classes', () => {
  expect(run('p nil.singleton_class,true.singleton_class,false.singleton_class')).toMatchObject({
    stdout: 'NilClass\nTrueClass\nFalseClass\n',
  });
});

test('record separator assignments preserve US-ASCII encoding', () => {
  expect(run('$/=[[]].join;s=$/.dup;s<<128;p s.bytes')).toMatchObject({ stdout: '[128]\n' });
});

test('active exception global rejects learner assignment', () => {
  expect(run('begin;raise "bad";rescue;begin;$!=nil;rescue=>e;p e.class,e.message;end;p $!.class;end')).toMatchObject({
    stdout: 'NameError\n"$! is a read-only variable"\nRuntimeError\n',
  });
});

test('abort uses replacement stderr and reports failure status', () => {
  expect(
    run(
      'class W;def write(x);$v<<x;end;end;$v=[];$stderr=W.new;begin;abort "oops";rescue SystemExit=>e;p e.status,e.success?;end;$stderr=STDERR;p $v'
    )
  ).toMatchObject({ stdout: '1\nfalse\n["oops", "\\n"]\n' });
  expect(run('begin;abort;rescue SystemExit=>e;p e.status,e.success?;end')).toMatchObject({
    stdout: '1\nfalse\n',
  });
  expect(
    run(
      String.raw`class W;def write(x);$v<<x;end;end;$v=[];$stderr=W.new;begin;abort "a\n";rescue SystemExit;end;begin;abort "";rescue SystemExit;end;$stderr=STDERR;p $v`
    )
  ).toMatchObject({ stdout: '["a\\n", "\\n"]\n' });
  expect(
    run(
      'class W;def write(x);$v<<x;$stderr=STDERR;end;end;$v=[];$stderr=W.new;begin;abort "hi";rescue SystemExit;end;p $v'
    )
  ).toMatchObject({ stdout: '["hi", "\\n"]\n' });
  expect(
    run('class A;def to_str;"yes";end;def to_s;"no";end;end;begin;abort A.new;rescue SystemExit=>e;p e.message;end')
  ).toMatchObject({ stdout: '"yes"\n' });
});

test('SystemExit initializes status and message independently', () => {
  expect(
    run(
      'e=SystemExit.new(3);p e.status,e.success?,e.message;e=SystemExit.new(2,"bad");p e.status,e.message;e=SystemExit.new("text");p e.status,e.message'
    )
  ).toMatchObject({ stdout: '3\nfalse\n"SystemExit"\n2\n"bad"\n0\n"text"\n' });
  expect(
    run(
      'class A;def to_int;2;end;end;class S<SystemExit;end;p SystemExit.new(A.new).status,SystemExit.new(1.5).status,SystemExit.new(false).status,S.new(4,"x").message'
    )
  ).toMatchObject({ stdout: '2\n1\n1\n"x"\n' });
});

test('NameError and NoMethodError retain constructed metadata', () => {
  expect(
    run(
      'e=NameError.new("oops",:foo,receiver:nil);p e.name,e.message,e.receiver;e=NoMethodError.new("bad",:bar,[1],true,receiver:nil);p e.name,e.args,e.private_call?,e.receiver'
    )
  ).toMatchObject({ stdout: ':foo\n"oops"\nnil\n:bar\n[1]\ntrue\nnil\n' });
});

test('exception metadata distinguishes missing fields from explicit nil', () => {
  expect(
    run(
      'begin;NameError.new.receiver;rescue=>e;p e.class,e.message;end;begin;FrozenError.new.receiver;rescue=>e;p e.class,e.message;end;begin;KeyError.new.key;rescue=>e;p e.class,e.message;end;p KeyError.new(key:nil).key,FrozenError.new(receiver:nil).receiver'
    )
  ).toMatchObject({
    stdout:
      'ArgumentError\n"no receiver is available"\nArgumentError\n"no receiver is available"\nArgumentError\n"no key is available"\nnil\nnil\n',
  });
});

test('process and option globals report unsupported runtime state', () => {
  for (const name of ['$$', '$-p', '$-l', '$-a']) {
    expect(run(`p ${name}`)).toMatchObject({
      uncaughtException: expect.stringContaining('この採点環境では使えません。'),
    });
  }
});

test('raise appends unknown keyword Hash once', () => {
  expect(run('begin;raise "x",foo:1,bar:2;rescue=>e;p e.class,e.message;end')).toMatchObject({
    stdout: 'TypeError\n"exception class/object expected"\n',
  });
});

test('Enumerable grouping and tally hash each new key once', () => {
  expect(run('class K;def hash;puts :hash;0;end;end;[1].group_by{K.new};[K.new].tally')).toMatchObject({
    stdout: 'hash\nhash\n',
  });
});

test('Hash group_by hashes each new grouping key once', () => {
  expect(run('class K;def hash;puts :hash;0;end;end;k=K.new;{a:1}.group_by{|x|k};p :done')).toMatchObject({
    stdout: 'hash\n:done\n',
  });
});

test('Hash invert rejects source insertion during value hashing', () => {
  expect(
    run('class K;def hash;$h[:c]=3;0;end;end;$h={a:K.new};begin;$h.invert;rescue=>e;p e.class;end;p $h.keys')
  ).toMatchObject({ stdout: 'RuntimeError\n[:a]\n' });
});

test('Hash reinitialization resets defaults while retaining entries', () => {
  expect(
    run('class H<Hash;def reset;initialize;end;end;h=H.new(3);h[:x]=1;h.reset;p [h[:missing],h.size]')
  ).toMatchObject({ stdout: '[nil, 1]\n' });
});

test('Hash fetch_values uses native lookup despite subclass fetch overrides', () => {
  expect(
    run(
      'class H<Hash;def fetch(k);puts :fetch;99;end;end;h=H[:a,1];p h.fetch_values(:a),h.fetch_values(:missing){|k|0}'
    )
  ).toMatchObject({ stdout: '[1]\n[0]\n' });
});

test('Hash flatten does not dispatch reopened Array flatten', () => {
  expect(run('class Array;def flatten(*args);puts :called;[:wrong];end;end;p({a:[1,2]}.flatten)')).toMatchObject({
    stdout: '[:a, [1, 2]]\n',
  });
});

test('Hash merge preserves receiver subclass and instance state', () => {
  expect(
    run(
      'class H<Hash;def initialize;@a=7;super;end;attr_reader :a;end;h=H.new;h[:a]=1;j=h.merge(b:2);p [j.class,j.a,j]'
    )
  ).toMatchObject({ stdout: '[H, 7, {a: 1, b: 2}]\n' });
});

test('Hash compact preserves subclass instance state', () => {
  expect(
    run(
      'class H<Hash;def initialize;@x=2;super;end;attr_reader :x;end;h=H.new;h[:a]=1;h[:b]=nil;p [h.compact.class,h.compact.x,h.compact]'
    )
  ).toMatchObject({ stdout: '[H, 2, {a: 1}]\n' });
});

test('Hash flatten rejects explicit nil depth', () => {
  expect(run('begin;p({a:[1]}.flatten(nil));rescue=>e;p e.class;end')).toMatchObject({ stdout: 'TypeError\n' });
});

test('Hash default_proc assignment clears stored default values', () => {
  expect(
    run('h=Hash.new(3);h.default_proc=nil;p h.default,h[:a];h.default_proc=proc{|h,k|4};p h.default,h[:a]')
  ).toMatchObject({
    stdout: 'nil\nnil\nnil\n4\n',
  });
});

test('Hash constructor validates default lambda arity', () => {
  expect(
    run(
      'begin;Hash.new(&->(a){1});rescue=>e;p e.class,e.message;end;begin;Hash.new(&->(a,b,c){1});rescue=>e;p e.class;end'
    )
  ).toMatchObject({ stdout: 'TypeError\n"default_proc takes two arguments (2 for 1)"\nTypeError\n' });
});

test('Array growth reports storage limits before catchable size errors', () => {
  expect(run('begin;Array.new(10000001);rescue=>e;p e.class;end;p :after')).toEqual({
    kind: 'limitExceeded',
    limit: 'storage',
  });
});

test('recursive Arrays compare without host stack overflow', () => {
  expect(run('a=[];a<<a;p a<=>a;b=[];b<<b;p a<=>b;a<<1;b<<2;p a<=>b')).toMatchObject({
    stdout: '0\n0\n-1\n',
  });
});

test('deep acyclic Array comparisons stop at configured depth', () => {
  expect(run('a=1;600.times{a=[a]};b=1;600.times{b=[b]};p a<=>b')).toEqual({
    kind: 'limitExceeded',
    limit: 'output',
  });
});

test('boxed Floats convert intrinsically for integer arguments', () => {
  expect(run('class Float;def to_int;puts :called;1;end;end;p [10,20][-0.0],[10,20][0.0]')).toMatchObject({
    stdout: '10\n10\n',
  });
  expect(run('class Float;def to_int;1;end;end;begin;[1][Float::INFINITY];rescue=>e;p e.class;end')).toMatchObject({
    stdout: 'RangeError\n',
  });
});

test('Range to_s retains endpoint encoding', () => {
  expect(
    run('s=(1..2).to_s;s<<128;p s.bytes;b=255.chr.clear;s=(b..b).to_s;begin;s<<256;rescue=>e;p e.class;end')
  ).toMatchObject({
    stdout: '[49, 46, 46, 50, 128]\nRangeError\n',
  });
});

test('core implicit to_s keeps US-ASCII results', () => {
  expect(run('[1,1.5,true,false,nil,:x].each{|v|s=[v].join;s<<128;p s.bytes}')).toMatchObject({
    stdout:
      '[49, 128]\n[49, 46, 53, 128]\n[116, 114, 117, 101, 128]\n[102, 97, 108, 115, 101, 128]\n[128]\n[120, 128]\n',
  });
});

test('Array Hash and Symbol inspection retain Ruby encodings', () => {
  expect(
    run('[[1],{},{a:1},[:x],:x].each{|v|s=v.inspect;s<<128;p s.bytes};s=["a"].inspect;s<<128;p s.bytes')
  ).toMatchObject({
    stdout:
      '[91, 49, 93, 128]\n[123, 125, 128]\n[123, 97, 58, 32, 49, 125, 128]\n[91, 58, 120, 93, 128]\n[58, 120, 128]\n[91, 34, 97, 34, 93, 194, 128]\n',
  });
});

test('boxed Floats compare equally across numeric representations', () => {
  expect(run('p [0]==[-0.0],[-0.0]==[0],[0.0]==[-0.0],[0].include?(-0.0)')).toMatchObject({
    stdout: 'true\ntrue\ntrue\ntrue\n',
  });
});

test('oversized String repetition and in-place expansion stop at storage limits', () => {
  expect(run('begin;"a"*1000001;rescue=>e;p e.class;end;p :after')).toEqual({
    kind: 'limitExceeded',
    limit: 'storage',
  });
  expect(run('begin;s="ΐ"*400000;s.upcase!;rescue=>e;p e.class;end;p :after')).toEqual({
    kind: 'limitExceeded',
    limit: 'storage',
  });
});

test('warning assembly retains US-ASCII output encoding', () => {
  expect(
    run(
      'class W;def write(x);$v<<x;end;end;$v=[];$stderr=W.new;warn 1.to_s;warn 1.to_s.clear;$stderr=STDERR;$v.each{|s|s<<128;p s.bytes}'
    )
  ).toMatchObject({ stdout: '[49, 10, 128]\n[10, 128]\n' });
});

test('Module name returns a stable frozen String', () => {
  expect(
    run('class A;end;p A.name.frozen?,A.name.equal?(A.name);begin;A.name<<"x";rescue=>e;p e.class;end')
  ).toMatchObject({
    stdout: 'true\ntrue\nFrozenError\n',
  });
});

test('nil and Boolean conversions reuse frozen String values', () => {
  expect(
    run(
      'p nil.to_s.frozen?,nil.to_s.equal?(nil.to_s),true.to_s.frozen?,true.to_s.equal?(true.inspect),false.to_s.frozen?'
    )
  ).toMatchObject({
    stdout: 'true\ntrue\ntrue\ntrue\ntrue\n',
  });
});

test('Hash any? stops at first match and guards callback insertion', () => {
  expect(run('h={a:1,b:2};n=0;p h.any?{|k,v|n+=1;true},n')).toMatchObject({ stdout: 'true\n1\n' });
  expect(run('h={a:1};begin;h.any?{|k,v|h[:b]=2;false};rescue=>e;p e.class;end;p h.keys')).toMatchObject({
    stdout: 'RuntimeError\n[:a]\n',
  });
});

test('Math.log handles large Integer bases', () => {
  expect(run('p Math.log(10**400,10**400),Math.log(10**500,10**400)')).toMatchObject({
    stdout: '1.0\n7.294959571961455\n',
  });
  expect(run('p Math.log(100,10**400)')).toMatchObject({ stdout: '3.4956057103414976e+17\n' });
});

test('to_set forwards mapping blocks and target Set classes', () => {
  expect(
    run(
      'class S<Set;end;p [1,2].to_set{|x|x*2}.to_a;p Set[1].to_set{|x|x*2}.to_a;p [1].to_set(S).class,Set[1].to_set(S).class'
    )
  ).toMatchObject({
    stdout: '[2, 4]\n[2]\nS\nS\n',
  });
});

test('Set to_set preserves identity with an explicit default class', () => {
  expect(run('s=Set[1];p s.to_set(Set).equal?(s)')).toMatchObject({ stdout: 'true\n' });
});

test('Enumerable reductions convert string-like method names', () => {
  expect(run('class A;private;def to_str;"+";end;end;p [1,2].inject(A.new),[1,2].reduce(10,A.new)')).toMatchObject({
    stdout: '3\n13\n',
  });
});

test('counted extrema reject sizes beyond Ruby collection bounds', () => {
  expect(
    run(
      'begin;[1,2].min(9223372036854775807);rescue=>e;p e.class,e.message;end;begin;[1,2].min_by(9223372036854775807){|x|x};rescue=>e;p e.class;end'
    )
  ).toMatchObject({
    stdout: 'ArgumentError\n"too big size"\nArgumentError\n',
  });
});

test('String searches check pattern encodings and between uses comparison methods', () => {
  expect(
    run(
      's=255.chr;begin;s.partition("é");rescue=>e;p e.class;end;begin;s.rpartition("é");rescue=>e;p e.class;end;begin;s.split("é");rescue=>e;p e.class;end;begin;s.scan("é");rescue=>e;p e.class;end'
    )
  ).toMatchObject({
    stdout: 'Encoding::CompatibilityError\n'.repeat(4),
  });
  expect(run('class S<String;def <=>(x);puts :cmp;0;end;end;p S.new("x").between?("a","b")')).toMatchObject({
    stdout: 'cmp\ncmp\ntrue\n',
  });
});

test('cycle rejects counts outside Ruby native bounds', () => {
  expect(
    run(
      'begin;[1].cycle(10**30){break};rescue=>e;p e.class;end;begin;p [1].cycle(10**30).size;rescue=>e;p e.class;end;p [].cycle(10**30).size'
    )
  ).toMatchObject({ stdout: 'RangeError\nRangeError\n0\n' });
});

test('Set operations raise ArgumentError for non-enumerable operands', () => {
  expect(
    run(
      's=Set[];begin;s.merge(3);rescue=>e;p e.class;end;begin;s.subtract(3);rescue=>e;p e.class;end;begin;s.replace(3);rescue=>e;p e.class;end;begin;s.intersection(3);rescue=>e;p e.class;end;begin;s.disjoint?(3);rescue=>e;p e.class;end'
    )
  ).toMatchObject({ stdout: 'ArgumentError\n'.repeat(5) });
});

test('putc reads only the first character of a long String', () => {
  expect(run('s="x"*100000;10.times{putc s}')).toMatchObject({ stdout: 'xxxxxxxxxx' });
});

test('warn suppresses disabled categories and writes each warning once', () => {
  expect(
    run(
      'class W;def write(x);$v<<x;end;end;$v=[];$stderr=W.new;warn "a",category: :deprecated;warn "b",category: :experimental;warn "c","d";$stderr=STDERR;p $v'
    )
  ).toMatchObject({ stdout: '["b\\n", "c\\nd\\n"]\n' });
});

test('warn preserves binary bytes and skips disabled warning level conversion', () => {
  expect(
    run(
      'class W;def write(s);$v<<s.bytes;end;end;class L;def to_int;puts :called;0;end;end;$v=[];$stderr=W.new;warn 255.chr;warn "x",category: :deprecated,uplevel:L.new;$stderr=STDERR;p $v'
    )
  ).toMatchObject({ stdout: '[[255, 10]]\n' });
});

test('warn retains empty binary message encoding', () => {
  expect(
    run(
      'class W;def write(s);$v<<s;end;end;$v=[];$stderr=W.new;warn 255.chr.clear;warn 255.chr.clear,"a";$stderr=STDERR;$v.each{|s|begin;s<<256;rescue=>e;p e.class;end}'
    )
  ).toMatchObject({ stdout: 'RangeError\nRangeError\n' });
});

test('warn assembles many short messages within operation limits', () => {
  expect(run('warn(*Array.new(20000,"x"));puts :ok')).toMatchObject({ stdout: 'ok\n' });
});

test('warn resolves stderr after message conversion', () => {
  expect(
    run(
      'class W;def initialize(n);@n=n;end;def write(s);$v<<[@n,s];end;end;class A;def to_s;$stderr=$b;"x";end;end;$v=[];$b=W.new(2);$stderr=W.new(1);warn A.new;$stderr=STDERR;p $v'
    )
  ).toMatchObject({ stdout: '[[2, "x\\n"]]\n' });
});

test('Range cover excludes empty Range arguments', () => {
  expect(run('p (1..3).cover?(2...2),(1..3).cover?(3..2),(1..3).cover?(2..2)')).toMatchObject({
    stdout: 'false\nfalse\ntrue\n',
  });
});

test('Range sum uses native addition for built-in numeric initial values', () => {
  expect(
    run(
      'class Integer;def +(x);puts :plus;99;end;end;class Float;def +(x);puts :float_plus;99;end;end;p (1..3).sum;p (1..3).sum(0.5)'
    )
  ).toMatchObject({ stdout: '6\n6.5\n' });
});

test('tally can insert after its key freezes the accumulator', () => {
  expect(run('class K;def hash;$h.freeze;0;end;end;$h={};[K.new].tally($h);p $h.size')).toMatchObject({
    stdout: '1\n',
  });
});

test.each([129, 500])('acyclic Sets inspect at depth %i within the configured limit', (depth) => {
  const result = run(`a=1;${depth}.times{a=Set[a]};p a`);
  expect(result.kind).toBe('executed');
  if (result.kind !== 'executed') throw new Error('Expected Ruby execution');
  expect(result.stdout).toBe(`${'Set['.repeat(depth)}1${']'.repeat(depth)}\n`);
});

test('infinite Range steps yield equal exclusive endpoints', () => {
  expect(run('p (1...1).step(Float::INFINITY).to_a,(1...1).step(-Float::INFINITY).to_a')).toMatchObject({
    stdout: '[1.0]\n[1.0]\n',
  });
});

test('Set identity equality skips member hash callbacks', () => {
  expect(run('class K;def hash;puts :hash;0;end;end;s=Set[K.new];puts :start;p s==s,s.eql?(s)')).toMatchObject({
    stdout: 'hash\nstart\ntrue\ntrue\n',
  });
});

test('Set inspection charges new member text once', () => {
  expect(run('s=Set.new(1..10000);p s.inspect.size')).toMatchObject({ stdout: '58897\n' });
});

test('Array flatten charges each appended element once', () => {
  expect(run('p Array.new(20000,1).flatten.size')).toMatchObject({ stdout: '20000\n' });
});

test('Array growth charges newly appended elements', () => {
  expect(run('a=[];20000.times{|i|a<<i};p a.size,Array.new(20000){1}.size')).toMatchObject({
    stdout: '20000\n20000\n',
  });
});

test('Array join streams nested bytes without repeated reconstruction', () => {
  expect(run('a="x"*900000;500.times{a=[a]};p a.join.size')).toMatchObject({ stdout: '900000\n' });
});

test('nested Array join reports Ruby encoding names', () => {
  expect(
    run('begin;["é",[255.chr]].join;rescue=>e;p e.message;end;begin;[255.chr,["é"]].join;rescue=>e;p e.message;end')
  ).toMatchObject({
    stdout:
      '"incompatible character encodings: UTF-8 and BINARY (ASCII-8BIT)"\n"incompatible character encodings: BINARY (ASCII-8BIT) and UTF-8"\n',
  });
});

test('Array join retains an empty binary first element', () => {
  expect(
    run('a=255.chr.clear;[[a],[a,["a"]],[a,[]]].each{|items|s=items.join(":");begin;s<<256;rescue=>e;p e.class;end}')
  ).toMatchObject({ stdout: 'RangeError\nRangeError\nRangeError\n' });
  expect(run('a=255.chr.clear;s=[a,"é"].join;s<<256;p s.bytes')).toMatchObject({
    stdout: '[195, 169, 196, 128]\n',
  });
});

test('Array join retains empty child US-ASCII encoding', () => {
  expect(
    run(
      's=[[],"a"].join(":");s<<128;p s.bytes;s=[[[]],"a"].join(":");s<<128;p s.bytes;s=[[],[]].join(":");begin;s<<256;rescue=>e;p e.class;end'
    )
  ).toMatchObject({ stdout: '[58, 97, 128]\n[58, 97, 128]\nRangeError\n' });
  expect(run('s=[[],"é"].join(":");s<<256;p s.bytes')).toMatchObject({
    stdout: '[58, 195, 169, 196, 128]\n',
  });
  expect(run('s=[[],"a"].join(":");[s.dup,s+"b",s.clear].each{|v|v<<128;p v.bytes}')).toMatchObject({
    stdout: '[58, 97, 128]\n[58, 97, 98, 128]\n[128]\n',
  });
});

test('String results preserve US-ASCII through extraction and transforms', () => {
  expect(run('s=[[]].join;[s.chr,s.upcase,s.reverse,s.strip,s.slice(0,0)].each{|t|t<<128;p t.bytes}')).toMatchObject({
    stdout: '[128]\n'.repeat(5),
  });
});

test('US-ASCII integer append promotes encoding or rejects incompatible text', () => {
  expect(
    run('s=[[]].join;s<<128;begin;s<<"é";rescue=>e;p e.class;end;begin;s+"é";rescue=>e;p e.class;end')
  ).toMatchObject({ stdout: 'Encoding::CompatibilityError\nEncoding::CompatibilityError\n' });
  expect(run('s=[[],"a"].join(":");s<<128;begin;s<<"é";rescue=>e;p e.class,e.message;end')).toMatchObject({
    stdout: 'Encoding::CompatibilityError\n"incompatible character encodings: US-ASCII and UTF-8"\n',
  });
});

test('numeric String conversions retain US-ASCII encoding', () => {
  expect(run('s=1.to_s;s<<128;p s.bytes;s=1.5.to_s;s<<128;p s.bytes;s=7.inspect;s<<128;p s.bytes')).toMatchObject({
    stdout: '[49, 128]\n[49, 46, 53, 128]\n[55, 128]\n',
  });
});

test('String each_char yields characters with US-ASCII encoding', () => {
  expect(run('s=[[],"a"].join;t=s.each_char.first;t<<128;p t.bytes;s.each_char{|c|c<<128;p c.bytes}')).toMatchObject({
    stdout: '[97, 128]\n[97, 128]\n',
  });
});

test('format retains US-ASCII template encoding', () => {
  expect(run('s=([[]].join % []);s<<128;p s.bytes;s=format([[],"a"].join(":"));s<<128;p s.bytes')).toMatchObject({
    stdout: '[128]\n[58, 97, 128]\n',
  });
});

test('format rejects unmatched named selectors after width or precision', () => {
  expect(
    run('for f in ["%2<a","%.2<a","%12<ab"];begin;format(f,{a:1});rescue=>e;p e.class,e.message;end;end')
  ).toMatchObject({
    stdout: 'ArgumentError\n"malformed name - unmatched parenthesis"\n'.repeat(3),
  });
});

test('format charges only newly appended directive text', () => {
  expect(run('f="%s"*25000;p format(f,*Array.new(25000,"x")).size')).toMatchObject({ stdout: '25000\n' });
});

test('interpolation retains the first empty binary segment when another follows', () => {
  expect(
    run(
      'b=255.chr.clear;["#{b}a","#{b}#{"a"}","#{b}#{b}"].each{|s|begin;s<<256;rescue=>e;p e.class;end};s="#{b}";s<<256;p s.bytes'
    )
  ).toMatchObject({ stdout: 'RangeError\nRangeError\nRangeError\n[196, 128]\n' });
});

test('Array values_at keeps one large result within the slot budget', () => {
  expect(run('p [].values_at(0...600000).size')).toMatchObject({ stdout: '600000\n' });
  expect(run('p [].values_at(0...300000,0...300000).size')).toMatchObject({ stdout: '600000\n' });
});

test('Array join enforces String storage as an execution limit', () => {
  expect(run('begin;Array.new(2,"a"*600000).join;rescue=>e;p e.class;end;p :after')).toEqual({
    kind: 'limitExceeded',
    limit: 'storage',
  });
});

test('Array join bounds nested container depth without host stack errors', () => {
  expect(run('a="x";129.times{a=[a]};p a.join')).toMatchObject({ stdout: '"x"\n' });
  expect(run('a="x";600.times{a=[a]};p a.join')).toEqual({ kind: 'limitExceeded', limit: 'output' });
});

test('Range cover dispatches the receiver endpoint comparison', () => {
  expect(
    run(
      'class A;attr_reader :n;def initialize(n);@n=n;end;def <=>(x);return -1 if @n==5 && x.n==4;@n<=>x.n;end;end;a=A.new(1)..A.new(5);b=A.new(2)..A.new(4);p a.cover?(b)'
    )
  ).toMatchObject({ stdout: 'false\n' });
});

test('Random copies large seeded state without reseeding', () => {
  expect(run('r=Random.new(2**5000000);3.times{r.dup};puts :ok')).toMatchObject({ stdout: 'ok\n' });
});

test('large Integer arithmetic follows execution budgets instead of a fixed bit ceiling', () => {
  expect(run('p (2**16000001).bit_length,(1<<32000001).bit_length')).toMatchObject({
    stdout: '16000002\n32000002\n',
  });
});

test('Enumerator each_with_index rejects offsets while with_index accepts them', () => {
  expect(
    run(
      'e=[1].each;begin;e.each_with_index(5).to_a;rescue=>x;p x.class,x.message;end;begin;e.each_with_index(5){|v,i|p i};rescue=>x;p x.class;end;p e.each_with_index.to_a,e.with_index(5).to_a'
    )
  ).toMatchObject({
    stdout: 'ArgumentError\n"wrong number of arguments (given 1, expected 0)"\nArgumentError\n[[1, 0]]\n[[1, 5]]\n',
  });
});

test('large repeated combination sizes use a short exact calculation', () => {
  expect(
    run('p [1,2].repeated_combination(9007199254740992).size,[1,2,3].repeated_combination(9007199254740992).size')
  ).toMatchObject({
    stdout: '9007199254740993\n40564819207303354358693384683521\n',
  });
  expect(run('p [1,2].repeated_combination(1000001).size')).toMatchObject({ stdout: '1000002\n' });
});

test('Enumerator Chain each rejects extra arguments when iteration starts', () => {
  expect(
    run(
      'begin;[1,2].chain([3]).each(3).to_a;rescue=>e;p e.class,e.message;end;begin;[1].chain([2]).each(3){|x|p x};rescue=>e;p e.class;end'
    )
  ).toMatchObject({
    stdout: 'ArgumentError\n"wrong number of arguments (given 1, expected 0)"\nArgumentError\n',
  });
});

test('recursive Sets inspect with a cycle marker', () => {
  expect(run('s=Set[];s.add(s);p s')).toMatchObject({ stdout: 'Set[Set[...]]\n' });
  expect(run('a=Set[];b=Set[a];a.add(b);p a')).toMatchObject({ stdout: 'Set[Set[Set[...]]]\n' });
});

test('empty RuntimeError descriptions match Ruby reporting', () => {
  expect(run('raise RuntimeError.new("")')).toMatchObject({ uncaughtException: 'unhandled exception' });
  expect(run('raise ArgumentError.new("")')).toMatchObject({ uncaughtException: 'ArgumentError' });
});

test('Set intersection processes Enumerable members as yielded', () => {
  const source =
    'class K;def hash;puts :hash;0;end;end;class E;include Enumerable;def each;puts :before;yield K.new;puts :after;end;end;Set[] & E.new';
  expect(run(source)).toMatchObject({ stdout: 'before\nhash\nafter\n' });
});

test('Set operations process Enumerable members before later yields', () => {
  const header =
    'class K;def hash;puts :hash;0;end;end;class E;include Enumerable;def each;puts :before;yield K.new;puts :after;end;end;';
  expect(run(`${header}Set[].merge(E.new)`)).toMatchObject({ stdout: 'before\nhash\nafter\n' });
  expect(run(`${header}Set[].subtract(E.new)`)).toMatchObject({ stdout: 'before\nhash\nafter\n' });
  expect(run(`${header}p Set[].disjoint?(E.new)`)).toMatchObject({ stdout: 'before\nhash\nafter\ntrue\n' });
  expect(run(`${header}p Set[].intersect?(E.new)`)).toMatchObject({ stdout: 'before\nhash\nafter\nfalse\n' });
});

test('Set symmetric difference invokes subclass initialization with its operand', () => {
  expect(
    run('class S<Set;def initialize(x,y);super(x);end;end;s=S.new([1],2);begin;s ^ Set[2];rescue=>e;p e.message;end')
  ).toMatchObject({
    stdout: '"wrong number of arguments (given 1, expected 2)"\n',
  });
  expect(
    run('class S<Set;def initialize(x=nil);super([9]);merge(x) if x;end;end;s=S.new([1,2]);p (s^Set[2]).to_a')
  ).toMatchObject({
    stdout: '[1]\n',
  });
});

test('finite Array flatten depth permits recursive references', () => {
  expect(run('a=[];a<<a;x=a.flatten(1);p x.size,x[0].equal?(a);p a.flatten!(2).equal?(a)')).toMatchObject({
    stdout: '1\ntrue\ntrue\n',
  });
  expect(run('a=[];a<<a;begin;a.flatten;rescue=>e;p e.class;end')).toMatchObject({ stdout: 'ArgumentError\n' });
});

test('Set union and difference duplicate subclasses while flatten initializes them', () => {
  expect(
    run('class S<Set;def initialize(x,y);super(x);end;end;s=S.new([1],2);p (s|Set[2]).to_a,(s-Set[]).to_a')
  ).toMatchObject({
    stdout: '[1, 2]\n[1]\n',
  });
  expect(
    run('class S<Set;def initialize(x=nil);puts :init;super(x);end;end;s=S.new([1]);puts :start;p s.flatten.class')
  ).toMatchObject({
    stdout: 'init\nstart\ninit\nS\n',
  });
});

test('Set operations hash members as an operand yields them', () => {
  expect(
    run(
      'class K;def hash;puts :hash;0;end;end;class E;include Enumerable;def each;puts :before;yield K.new;puts :after;end;end;Set[]|E.new'
    )
  ).toMatchObject({
    stdout: 'before\nhash\nafter\n',
  });
});

test('Set operand traversal rejects insertion from member hashes', () => {
  expect(
    run(
      'class K;attr_accessor :on;def hash;$s.add(9) if @on;0;end;end;k=K.new;$s=Set[k];k.on=true;begin;(Set[]|$s);rescue=>e;p e.class;end;p $s.size'
    )
  ).toMatchObject({
    stdout: 'RuntimeError\n1\n',
  });
});

test('Set operations use each added to immediate classes', () => {
  expect(run('class Integer;def each;yield 2;end;end;p Set[1]|3,Set[1]^3')).toMatchObject({
    stdout: 'Set[1, 2]\nSet[1, 2]\n',
  });
});

test('boxed Floats keep immutable clone and singleton rules', () => {
  expect(
    run(
      'begin;Float::MAX.clone(freeze:false);rescue=>e;p e.class;end;module M;end;begin;Float::MAX.extend(M);rescue=>e;p e.class;end'
    )
  ).toMatchObject({
    stdout: 'ArgumentError\nTypeError\n',
  });
  expect(run('module M;def self.extend_object(x);puts :hook;end;end;Float::MAX.extend(M)')).toMatchObject({
    stdout: 'hook\n',
  });
});

test('lambda requires a literal block', () => {
  expect(run('p=proc{|x|x};begin;q=lambda(&p);p p.lambda?;rescue=>e;p e.class;end')).toMatchObject({
    stdout: 'ArgumentError\n',
  });
  expect(run('p lambda{|x|x}.lambda?')).toMatchObject({ stdout: 'true\n' });
});

test('to_enum uses only its supplied size block', () => {
  expect(run('e=[1,2].to_enum(:each){puts :size;7};p e.size,[1,2].to_enum(:each).size')).toMatchObject({
    stdout: 'size\n7\nnil\n',
  });
});

test('raise invokes private exception conversion', () => {
  expect(
    run('class A;private;def exception;RuntimeError.new("x");end;end;begin;raise A.new;rescue=>e;p e.class;end')
  ).toMatchObject({
    stdout: 'RuntimeError\n',
  });
});

test('Array conversion honors reopened NilClass methods', () => {
  expect(run('class NilClass;def to_a;[1];end;end;p Array(nil)')).toMatchObject({ stdout: '[1]\n' });
});

test('Class.new rejects Class as a superclass', () => {
  expect(run('begin;Class.new(Class);rescue=>e;p e.class;end')).toMatchObject({ stdout: 'TypeError\n' });
});

test('inherited visibility preserves method ownership for super', () => {
  expect(
    run(
      'class Z;def f;puts :z;end;end;class A<Z;def f;puts :a;super;end;end;class B<A;private :f;def g;f;end;end;B.new.g'
    )
  ).toMatchObject({
    stdout: 'a\nz\n',
  });
});

test('inherited visibility follows later ancestor redefinitions', () => {
  expect(run('class A;def f;1;end;end;class B<A;public :f;end;class A;def f;2;end;end;p B.new.f')).toMatchObject({
    stdout: '2\n',
  });
});

test('Comparable equality interprets comparison result signs', () => {
  expect(run('class A;include Comparable;def <=>(x);-0.0;end;end;p A.new==A.new')).toMatchObject({
    stdout: 'true\n',
  });
});

test('Proc curry validates native arity bounds', () => {
  expect(run('begin;proc{}.curry(10**30);rescue=>e;p e.class;end')).toMatchObject({ stdout: 'RangeError\n' });
});

test('warn validates keyword options before writing', () => {
  expect(run('begin;warn("x",foo:1);rescue=>e;p e.class;end')).toMatchObject({ stdout: 'ArgumentError\n' });
  expect(run('begin;warn("x",uplevel:-1);rescue=>e;p e.class;end')).toMatchObject({ stdout: 'ArgumentError\n' });
  expect(run('begin;warn("x",category: :bad);rescue=>e;p e.class;end')).toMatchObject({ stdout: 'ArgumentError\n' });
  expect(run('begin;warn("x",uplevel:10**30);rescue=>e;p e.class;end')).toMatchObject({ stdout: 'RangeError\n' });
  expect(
    run('class A;def to_int;puts :conv;0;end;end;begin;warn("x",uplevel:A.new,foo:1);rescue=>e;p e.class;end')
  ).toMatchObject({
    stdout: 'ArgumentError\n',
  });
  expect(run('begin;warn(uplevel:-1);puts :ok;rescue=>e;p e.class;end')).toMatchObject({ stdout: 'ok\n' });
  expect(
    run(
      'class A;def to_int;puts :conv;0;end;end;begin;warn("x",uplevel:A.new,category: :wrong);rescue=>e;p e.class;end'
    )
  ).toMatchObject({
    stdout: 'ArgumentError\n',
  });
});

test('deep Ruby containers remain within the interpreter stack', () => {
  expect(run('a=1;5000.times{a=[a]};puts a')).toMatchObject({ stdout: '1\n' });
  const inspected = run('a=1;5000.times{a=[a]};p a');
  expect(inspected).toMatchObject({ stdout: `${'['.repeat(5000)}1${']'.repeat(5000)}\n` });
  expect(run('a=1;b=1;5000.times{a=[a];b=[b]};p a==b,a.eql?(b)')).toMatchObject({ stdout: 'true\ntrue\n' });
});

test('String selectors read current contents after index conversion', () => {
  expect(run('class I;def to_int;$s.replace("cd");0;end;end;$s="ab";p $s[I.new],$s')).toMatchObject({
    stdout: '"c"\n"cd"\n',
  });
  expect(run('class I;def to_int;$s.replace("cd");0;end;end;$s="ab";p $s.byteslice(I.new)')).toMatchObject({
    stdout: '"c"\n',
  });
  expect(
    run('class I;def to_int;$s.replace("cd");0;end;end;$s="ab";p $s.slice!(I.new),$s;$s="ab";$s[I.new]="x";p $s')
  ).toMatchObject({
    stdout: '"c"\n"d"\n"xd"\n',
  });
});

test('binary String segments keep source bytes and encoding', () => {
  expect(
    run('s=255.chr;p s.lines[0].bytes,s.grapheme_clusters[0].bytes,s.delete("a").bytes,s.squeeze.bytes')
  ).toMatchObject({
    stdout: '[255]\n[255]\n[255]\n[255]\n',
  });
  expect(run('s=255.chr;begin;s.lines[0]+"é";rescue=>e;p e.class;end')).toMatchObject({
    stdout: 'Encoding::CompatibilityError\n',
  });
  expect(run('p (255.chr+13.chr+10.chr).grapheme_clusters.map{|x|x.bytes}')).toMatchObject({
    stdout: '[[255], [13], [10]]\n',
  });
  expect(
    run(
      's=255.chr+"a";p s.split("a")[0].bytes,s.partition("a")[0].bytes,s.rpartition("a")[0].bytes,255.chr.scan(255.chr)[0].bytes'
    )
  ).toMatchObject({
    stdout: '[255]\n[255]\n[255]\n[255]\n',
  });
  expect(run('s=255.chr+"a";x=s.partition("a")[1];x<<256;p x.bytes')).toMatchObject({
    stdout: '[97, 196, 128]\n',
  });
  expect(run('n="b";x="abc".partition(n)[1];x<<"!";p n')).toMatchObject({ stdout: '"b!"\n' });
});

test('shuffle detects receiver changes from its randomizer', () => {
  expect(
    run(
      'class R;def rand(n);$a.replace([8]);0;end;end;$a=[1,2,3];begin;$a.shuffle!(random:R.new);rescue=>e;p e.class,e.message;end;p $a'
    )
  ).toMatchObject({
    stdout: 'RuntimeError\n"modified during shuffle"\n[8]\n',
  });
});

test('Array delete retains contents when an equality callback raises', () => {
  expect(
    run(
      'class X;def initialize(n);@n=n;end;def ==(v);raise "bad" if @n==2;true;end;end;$a=[X.new(1),X.new(2),3];begin;$a.delete(0);rescue;end;p $a.size'
    )
  ).toMatchObject({
    stdout: '3\n',
  });
});

test('Array delete does not restore elements removed by callbacks', () => {
  expect(run('class X;def ==(v);$a.clear;true;end;end;$a=[8,X.new];$a.delete(0);p $a')).toMatchObject({
    stdout: '[]\n',
  });
});

test('Array delete retains unrelated in-place callback changes', () => {
  expect(run('class X;def ==(v);$a<<9;true;end;end;$a=[8,X.new,1];$a.delete(0);p $a')).toMatchObject({
    stdout: '[8, 1, 9]\n',
  });
  expect(run('class X;def ==(v);$a[0]=7;true;end;end;$a=[8,X.new,1];$a.delete(0);p $a')).toMatchObject({
    stdout: '[7, 1]\n',
  });
  expect(run('class X;def ==(v);$a.replace([7,6,5]);true;end;end;$a=[8,X.new,1];$a.delete(0);p $a')).toMatchObject({
    stdout: '[7, 5]\n',
  });
});

test('Integer iteration uses relational coercion', () => {
  expect(
    run(
      'class T;def >(x);puts :gt;false;end;def <=>(x);puts :cmp;1;end;end;class A;def coerce(x);[T.new,0];end;end;1.upto(A.new){|x|p x;break}'
    )
  ).toMatchObject({
    stdout: 'gt\n1\n',
  });
});

test('Numeric step uses relational coercion for custom limits', () => {
  expect(
    run(
      'class T;def >(x);puts :gt;false;end;def <=>(x);puts :cmp;1;end;end;class A;def coerce(x);[T.new,0];end;end;1.step(A.new){|x|p x;break}'
    )
  ).toMatchObject({
    stdout: 'gt\n1\n',
  });
});

test('indexed method calls accept block arguments', () => {
  expect(run('class A;def [];yield;end;end;p A.new[&proc{42}]')).toMatchObject({ stdout: '42\n' });
});

test('frozen objects reject new singleton methods', () => {
  expect(
    run(
      'class A;def f;freeze;def self.x;1;end;end;end;a=A.new;begin;a.f;rescue=>e;p e.class;end;begin;p a.x;rescue=>e;p e.class;end'
    )
  ).toMatchObject({
    stdout: 'FrozenError\nNoMethodError\n',
  });
});

test('implicit super converts reassigned rest parameters', () => {
  expect(run('class A;def f(*x);p x;end;end;class B<A;def f(*x);x=5;super;end;end;B.new.f(1,2)')).toMatchObject({
    stdout: '[5]\n',
  });
  expect(
    run(
      'class A;def f(**x);p x;end;end;class B<A;def f(**x);x=5;super;end;end;begin;B.new.f(a:1);rescue=>e;p e.class;end'
    )
  ).toMatchObject({
    stdout: 'TypeError\n',
  });
});

test('implicit output conversions invoke private methods', () => {
  expect(run('class A;private;def to_s;"yes";end;def inspect;"shown";end;end;puts A.new;p A.new')).toMatchObject({
    stdout: 'yes\nshown\n',
  });
});

test('String inspection prints private-use Unicode characters', () => {
  expect(run(String.raw`p "\u{e000}","\u{f0000}"`)).toMatchObject({ stdout: '"\uE000"\n"\u{F0000}"\n' });
});

test('container eql skips callbacks for identical members', () => {
  expect(run('class X;def eql?(v);puts :called;false;end;end;x=X.new;p [x].eql?([x]),{a:x}.eql?({a:x})')).toMatchObject(
    {
      stdout: 'true\ntrue\n',
    }
  );
  expect(run('x=Float::NAN;p [x].eql?([x])')).toMatchObject({ stdout: 'true\n' });
});

test('ArithmeticSequence last computes ratios before infinite-step results', () => {
  for (const source of [
    'Float::INFINITY.step(1.0, Float::INFINITY).last',
    'Float::NAN.step(1.0, Float::INFINITY).last(2)',
    'Float::INFINITY.step(1.0, Float::INFINITY).last(0)',
  ]) {
    expect(run(`p ${source}`)).toMatchObject({ uncaughtException: 'NaN (FloatDomainError)' });
  }
  expect(
    run(
      'p 1.0.step(3.0, Float::INFINITY).last, 1.0.step(3.0, Float::INFINITY).last(2), 1.0.step(3.0, Float::INFINITY).last(0)'
    )
  ).toMatchObject({
    stdout: 'NaN\n[NaN]\n[]\n',
  });
});

test('Array multiplication accepts implicit String separators', () => {
  expect(run('class A; def to_str; ","; end; end; p [1,2] * A.new')).toMatchObject({ stdout: '"1,2"\n' });
  expect(run('class A; private; def to_str; "-"; end; end; p [1,2] * A.new')).toMatchObject({ stdout: '"1-2"\n' });
  expect(run('class A; def to_str; nil; end; def to_int; 2; end; end; p [1,2] * A.new')).toMatchObject({
    stdout: '[1, 2, 1, 2]\n',
  });
});

test('Array fill follows receiver changes from callbacks', () => {
  expect(run('a=[1,2,3]; a.fill { |i| a.clear if i==0; 9 }; p a')).toMatchObject({ stdout: '[]\n' });
  expect(run('a=[1,2,3]; a.fill { |i| a.replace([8]) if i==0; 9 }; p a')).toMatchObject({ stdout: '[9]\n' });
});

test('Array map writes callback results to the current receiver', () => {
  expect(run('a=[1,2,3]; a.map! { |x| a.clear if x==1; x }; p a')).toMatchObject({ stdout: '[1]\n' });
  expect(run('a=[1,2,3]; a.map! { |x| a.replace([8]) if x==1; x }; p a')).toMatchObject({ stdout: '[1]\n' });
});

test('Array join invokes private implicit String conversions', () => {
  expect(
    run('class A; private; def to_str; "yes"; end; public; def to_s; "no"; end; end; p [A.new].join')
  ).toMatchObject({
    stdout: '"yes"\n',
  });
});

test('Array permutation uses a bounded host stack and preserves order', () => {
  expect(run('p [1,2,3].permutation(2).to_a')).toMatchObject({
    stdout: '[[1, 2], [1, 3], [2, 1], [2, 3], [3, 1], [3, 2]]\n',
  });
  expect(run('Array.new(20000,1).permutation(20000) { break }; puts :ok')).toMatchObject({ stdout: 'ok\n' });
});

test('Array reverse find returns the yielded value after receiver mutation', () => {
  expect(run('a=[1,2]; p a.rfind { |x| a.clear; true }')).toMatchObject({ stdout: '2\n' });
  expect(run('a=[1,2]; p a.rfind { |x| a[1]=9; true }')).toMatchObject({ stdout: '2\n' });
});

test('Array sample observes receiver mutation by custom randomizers', () => {
  expect(
    run('class R; def rand(n); $a.clear; 0; end; end; $a=[1,2,3]; p $a.sample(random:R.new), $a.sample(2,random:R.new)')
  ).toMatchObject({
    stdout: 'nil\n[]\n',
  });
  expect(
    run('class R; def rand(n); $a.replace([8]); 0; end; end; $a=[1,2,3]; p $a.sample(2,random:R.new), $a')
  ).toMatchObject({
    stdout: '[8]\n[8]\n',
  });
});

test('Array binary search returns nil after callback shrinkage', () => {
  expect(run('a=[1,2,3]; p a.bsearch { |x| a.clear; 0 }')).toMatchObject({ stdout: 'nil\n' });
  expect(run('a=[1,2,3]; p a.bsearch { |x| a.clear; true }')).toMatchObject({ stdout: 'nil\n' });
});

test('Hash value searches reject insertion during equality callbacks', () => {
  for (const method of ['value?', 'key']) {
    expect(
      run(
        `class A; def ==(x); $h[:b]=2; false; end; end; $h={a:A.new}; begin; p $h.${method}(0); rescue => e; p e.class, e.message; end; p $h.size`
      )
    ).toMatchObject({
      stdout: 'RuntimeError\n"can\'t add a new key into hash during iteration"\n1\n',
    });
  }
});

test('Hash replacement rejects iteration before changing entries', () => {
  expect(
    run('h={a:1,b:2}; begin; h.each { h.replace({c:3}) }; rescue => e; p e.class, e.message; end; p h')
  ).toMatchObject({
    stdout: 'RuntimeError\n"can\'t replace hash during iteration"\n{a: 1, b: 2}\n',
  });
  expect(run('h={a:1}; begin; h.each_key { h.replace({}) }; rescue => e; p e.class; end; p h')).toMatchObject({
    stdout: 'RuntimeError\n{a: 1}\n',
  });
});

test('Hash copies preserve indexed entries without key hash callbacks', () => {
  expect(
    run(
      'class K; attr_accessor :bad; def hash; raise "bad" if @bad; 0; end; end; k=K.new; h={k=>1}; k.bad=true; p h.merge({}).size, h.except.size; d={a:2}; d.replace(h); p d.size'
    )
  ).toMatchObject({
    stdout: '1\n1\n1\n',
  });
});

test('Array delete preserves frozen contents on a matching value', () => {
  expect(run('a=[1,2,1].freeze; begin; a.delete(1); rescue => e; p e.class; end; p a')).toMatchObject({
    stdout: 'FrozenError\n[1, 2, 1]\n',
  });
  expect(run('p [1,2].freeze.delete(3)')).toMatchObject({ stdout: 'nil\n' });
});

test('Array sample applies draws to same-length replacements', () => {
  expect(
    run('class R; def rand(n); $a.replace([8,9,10]); n-1; end; end; $a=[1,2,3]; p $a.sample(2,random:R.new)')
  ).toMatchObject({
    stdout: '[10, 9]\n',
  });
});

test('Hash equality guards both operands during key callbacks', () => {
  expect(
    run(
      'class A; attr_accessor :on; def hash; $h[:x]=1 if @on; 0; end; end; k=A.new; $h={k=>1}; g={k=>1}; k.on=true; begin; p $h.eql?(g); rescue => e; p e.class,e.message; end; p $h.size'
    )
  ).toMatchObject({
    stdout: 'RuntimeError\n"can\'t add a new key into hash during iteration"\n1\n',
  });
});

test('Array map fills cleared positions with Ruby nil', () => {
  expect(run('a=[1,2,3]; a.map! { |x| a.clear if x==2; x }; p a')).toMatchObject({ stdout: '[nil, 2]\n' });
  expect(run('a=[1,2,3]; a.collect! { |x| a.clear if x==3; x }; p a')).toMatchObject({
    stdout: '[nil, nil, 3]\n',
  });
});

test('String scan and substitution observe permitted same-length callback edits', () => {
  expect(run('s="aaa"; s.scan("a") { s.replace("bbb"); puts :hit }')).toMatchObject({ stdout: 'hit\n' });
  expect(run('s="aaa"; p s.gsub("a") { s[1]="b"; "x" }')).toMatchObject({ stdout: '"xbx"\n' });
});

test('large Array samples retain the pre-callback snapshot', () => {
  expect(
    run('class R; def rand(n); $a.replace([8,9]); 0; end; end; $a=(1..20).to_a; p $a.sample(11,random:R.new)')
  ).toMatchObject({
    stdout: '[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]\n',
  });
});

test('String successor carries the maximum Unicode code point without host errors', () => {
  expect(run(String.raw`p "\u{10ffff}".succ.bytes, "\u{10ffff}\xFF".next.bytes`)).toMatchObject({
    stdout: '[1, 240, 144, 128, 128]\n[1, 240, 144, 128, 128, 255]\n',
  });
});

test('Enumerable to_h forwards arguments to custom each', () => {
  expect(
    run(
      'class A; include Enumerable; def each(n); yield [:a,n]; end; end; p A.new.to_h(3), A.new.to_h(4) { |pair| [:b, pair[1]] }'
    )
  ).toMatchObject({
    stdout: '{a: 3}\n{b: 4}\n',
  });
});

test('zip accepts implicit Array conversions including private to_ary', () => {
  expect(run('class A; private; def to_ary; [3,4]; end; end; p [1,2].zip(A.new), (1..2).zip(A.new)')).toMatchObject({
    stdout: '[[1, 3], [2, 4]]\n[[1, 3], [2, 4]]\n',
  });
});

test('singleton repeated selection sizes retain large Integer counts', () => {
  expect(
    run('p [1].repeated_permutation(9007199254740992).size, [1].repeated_combination(9007199254740992).size')
  ).toMatchObject({
    stdout: '1\n1\n',
  });
});

test('large random seeds stay within the execution deadline', () => {
  expect(run('Random.new(2**5000000); puts :ok')).toMatchObject({ stdout: 'ok\n' });
});

test('large random limits draw within the execution deadline', () => {
  expect(run('r=Random.new(1).rand(2**3000000); p r>=0 && r<2**3000000')).toMatchObject({ stdout: 'true\n' });
});

test('implicit conversions invoke private methods and report invalid returns', () => {
  expect(run('class A; private; def to_int; 0; end; end; p [42].fetch(A.new), "x" * A.new')).toMatchObject({
    stdout: '42\n""\n',
  });
  expect(
    run('class A; def to_int; "x"; end; end; begin; [1].fetch(A.new); rescue => e; p e.message; end')
  ).toMatchObject({
    stdout: '"can\'t convert A to Integer (A#to_int gives String)"\n',
  });
  expect(run('class A; def to_str; 1; end; end; begin; "a" + A.new; rescue => e; p e.message; end')).toMatchObject({
    stdout: '"can\'t convert A to String (A#to_str gives Integer)"\n',
  });
});

test('Math invokes private Numeric to_f conversions', () => {
  expect(run('class A < Numeric; private; def to_f; 9.0; end; end; p Math.sqrt(A.new)')).toMatchObject({
    stdout: '3.0\n',
  });
});

test('shared Hash equality guards callbacks in both operands', () => {
  expect(
    run(
      'class V; def ==(v); $a[:x]=3; false; end; end; $a={k:V.new}; b={k:0}; begin; p $a==b; rescue => e; p e.class,e.message; end; p $a.size'
    )
  ).toMatchObject({
    stdout: 'RuntimeError\n"can\'t add a new key into hash during iteration"\n1\n',
  });
  expect(
    run(
      'class V; def eql?(v); $a[:x]=3; false; end; end; $a={k:V.new}; b={k:0}; begin; p [$a].eql?([b]); rescue => e; p e.class; end; p $a.size'
    )
  ).toMatchObject({
    stdout: 'RuntimeError\n1\n',
  });
});

test('shared container comparisons repeat completed equality callbacks', () => {
  expect(
    run('class X; def ==(x); $n+=1; $n==1; end; end; $n=0; a=[X.new]; b=[X.new]; p [a,a]==[b,b],$n')
  ).toMatchObject({
    stdout: 'false\n2\n',
  });
  expect(
    run('class X; def eql?(x); $n+=1; $n==1; end; end; $n=0; a=[X.new]; b=[X.new]; p [a,a].eql?([b,b]),$n')
  ).toMatchObject({
    stdout: 'false\n2\n',
  });
});

test('String ordering distinguishes incompatible equal bytes', () => {
  expect(run(String.raw`a=255.chr;b="\xFF";p a<=>b,b<=>a,65.chr<=>"A"`)).toMatchObject({
    stdout: '-1\n1\n0\n',
  });
});

test('percent-p formatting preserves custom inspect bytes', () => {
  expect(
    run(String.raw`class A;def inspect;"\xFF";end;end;p format("%p",A.new).bytes,format("%3p",A.new).bytes`)
  ).toMatchObject({
    stdout: '[255]\n[32, 32, 255]\n',
  });
});

test('format numeric directives invoke private conversion methods', () => {
  expect(
    run('class A; private; def to_f; 2.5; end; def to_i; 7; end; end; p format("%f %d",A.new,A.new)')
  ).toMatchObject({
    stdout: '"2.500000 7"\n',
  });
});

test('multiple assignment snapshots values before setter callbacks', () => {
  expect(run('class A; def x=(v); $a[1]=9; end; end; $a=[1,2]; A.new.x,b=$a; p b,$a')).toMatchObject({
    stdout: '2\n[1, 9]\n',
  });
  expect(run('class A; def x=(v); $a[1]=9; end; end; $a=[1,2,3]; A.new.x,*b=$a; p b,$a')).toMatchObject({
    stdout: '[2, 3]\n[1, 9, 3]\n',
  });
});

test.each(['a==b', 'a.eql?(b)'])(
  'shared container equality through %s stays within the execution budget',
  (comparison) => {
    expect(run(`a=[1]; b=[1]; 24.times { a=[a,a]; b=[b,b] }; p ${comparison}`)).toMatchObject({
      kind: 'limitExceeded',
      limit: 'operations',
    });
  }
);

test('Hash equality permits mutation of the lookup operand', () => {
  expect(run('class V; def ==(v); $b[:x]=3; false; end; end; $a={k:V.new}; $b={k:0}; p $a==$b,$b.size')).toMatchObject({
    stdout: 'false\n2\n',
  });
  expect(
    run('class V; def eql?(v); $b[:x]=3; false; end; end; $a={k:V.new}; $b={k:0}; p $a.eql?($b),$b.size')
  ).toMatchObject({
    stdout: 'false\n2\n',
  });
});

test('percent-p exports binary inspect bytes as Ruby escapes', () => {
  expect(
    run('class A; def inspect; 255.chr; end; end; p format("%p",A.new).bytes, format("é%p",A.new).bytes')
  ).toMatchObject({
    stdout: '[92, 120, 70, 70]\n[195, 169, 92, 120, 70, 70]\n',
  });
});

test('String successor propagates maximum Unicode carry leftward', () => {
  expect(run(String.raw`p "!\u{10ffff}".succ.bytes, "\u{10ffff}\u{10ffff}".succ.bytes`)).toMatchObject({
    stdout: '[34, 240, 144, 128, 128]\n[1, 240, 144, 128, 128, 240, 144, 128, 128]\n',
  });
});

test('String successor wraps at every UTF-8 width boundary', () => {
  expect(
    run(String.raw`p "\u{7f}".succ.bytes, "\u{7ff}".succ.bytes, "\u{ffff}".succ.bytes, "!\u{7f}".succ.bytes`)
  ).toMatchObject({
    stdout: '[1, 0]\n[1, 194, 128]\n[1, 224, 160, 128]\n[34, 0]\n',
  });
});

test('zip validates Enumerable fallbacks before an empty receiver iterates', () => {
  expect(run('begin; (1...1).zip(5); rescue => e; p e.class,e.message; end')).toMatchObject({
    stdout: 'TypeError\n"wrong argument type Integer (must respond to :each)"\n',
  });
  expect(run('class A; def to_ary; nil; end; end; begin; [1].zip(A.new); rescue => e; p e.class; end')).toMatchObject({
    stdout: 'TypeError\n',
  });
  expect(run('class A; private; def each; yield 2; end; end; p [1].zip(A.new)')).toMatchObject({
    stdout: '[[1, 2]]\n',
  });
});

test('memoized Array sampling reads current receiver contents', () => {
  expect(
    run(
      'class R; def rand(n); $a.replace(Array.new(3000,9)); 0; end; end; $a=(1..3000).to_a; p $a.sample(11,random:R.new)'
    )
  ).toMatchObject({
    stdout: '[9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9]\n',
  });
  expect(
    run('class R; def rand(n); $a.replace([8,9]); 0; end; end; $a=(1..3000).to_a; p $a.sample(11,random:R.new)')
  ).toMatchObject({
    stdout: '[]\n',
  });
});

test('exclusive Float sequence sizes keep Ruby large-boundary tolerance', () => {
  expect(run('p (0.0...1.0).step(0.0000000000000002).size, (0.0...2.0).step(0.0000000000000004).size')).toMatchObject({
    stdout: '5000000000000001\n5000000000000001\n',
  });
});

test('Enumerator method names accept private implicit String conversion', () => {
  expect(
    run('class A; private; def to_str; "each"; end; end; p [1,2].to_enum(A.new).to_a, [1,2].enum_for(A.new).to_a')
  ).toMatchObject({
    stdout: '[1, 2]\n[1, 2]\n',
  });
});

test('empty Array zip converts inputs without requiring fallback each', () => {
  expect(run('p [].zip(5), [].zip(nil)')).toMatchObject({ stdout: '[]\n[]\n' });
  expect(run('class A; def to_ary; puts :converted; nil; end; end; p [].zip(A.new)')).toMatchObject({
    stdout: 'converted\n[]\n',
  });
});

test('String callbacks resume at byte offsets after equal-byte-length edits', () => {
  expect(run('s="éaa"; p s.gsub("a") { s[0]="bb" if s[0]=="é"; "x" }')).toMatchObject({
    stdout: '"bbxx"\n',
  });
  expect(run('s="éaa"; s.scan("a") { s[0]="bb" if s[0]=="é"; puts :hit }')).toMatchObject({
    stdout: 'hit\nhit\n',
  });
  for (const method of ['gsub', 'gsub!']) {
    expect(run(`s="aaaa"; p s.${method}("a") { s[0,2]="é" if s[0]=="a"; "x" }.bytes`)).toMatchObject({
      stdout: '[120, 169, 120, 120]\n',
    });
  }
  expect(run('s="éaaa"; s.scan("") { s[0]="bb" if s[0]=="é"; puts :hit }')).toMatchObject({
    stdout: 'hit\nhit\nhit\nhit\nhit\n',
  });
  expect(run('s="aaa"; p s.sub("a") { s[1]="b"; "x" }')).toMatchObject({ stdout: '"xaa"\n' });
  expect(run('s="aaa"; p s.sub!("a") { s[1]="b"; "x" }')).toMatchObject({ stdout: '"xba"\n' });
});

test('Enumerable tally reports invalid Hash conversion results', () => {
  expect(
    run('class A; def to_hash; nil; end; end; begin; [1].tally(A.new); rescue => e; p e.message; end')
  ).toMatchObject({
    stdout: '"can\'t convert A to Hash (A#to_hash gives NilClass)"\n',
  });
  expect(
    run('class A; def to_hash; 1; end; end; begin; [1].tally(A.new); rescue => e; p e.message; end')
  ).toMatchObject({
    stdout: '"can\'t convert A to Hash (A#to_hash gives Integer)"\n',
  });
});

test('Enumerable tally rejects non-Integer existing counts without callbacks', () => {
  expect(
    run('class A; def to_hash; {1=>1.5}; end; end; begin; [1].tally(A.new); rescue => e; p e.message; end')
  ).toMatchObject({
    stdout: '"wrong argument type Float (expected Integer)"\n',
  });
  expect(
    run('class B; def +(x); puts :called; 3; end; end; h={1=>B.new}; begin; [1].tally(h); rescue => e; p e.class; end')
  ).toMatchObject({
    stdout: 'TypeError\n',
  });
});

test('Hash structural hashing repeats child callbacks and guards insertion', () => {
  for (const nested of ['[X.new]', '{a:X.new}']) {
    expect(run(`class X; def hash; puts :hash; 0; end; end; t=${nested}; [t,t].hash`)).toMatchObject({
      stdout: 'hash\nhash\n',
    });
  }
  expect(
    run(
      'class V; def hash; $h[:x]=1; 0; end; end; $h={a:V.new}; begin; $h.hash; rescue => e; p e.class,e.message; end; p $h.size'
    )
  ).toMatchObject({ stdout: 'RuntimeError\n"can\'t add a new key into hash during iteration"\n1\n' });
});

test('tally rejects a negative existing count without changing its Hash', () => {
  expect(run('h={1=>-1};begin;[1].tally(h);rescue=>e;p e.class,e.message;end;p h')).toMatchObject({
    stdout: 'TypeError\n"wrong argument type Integer (expected Integer)"\n{1 => -1}\n',
  });
});

test('zero beginless bit slices and private numeric coercion follow Ruby', () => {
  expect(run('p 0[..10],0[...-1],0[..0]')).toMatchObject({ stdout: '0\n0\n0\n' });
  expect(run('class A; private; def coerce(x); [x,2]; end; end; p 5<=>A.new, 5.0<=>A.new')).toMatchObject({
    stdout: '1\n1\n',
  });
  expect(run('class I; def to_int; puts :called; 2; end; end; p 0[(I.new..)]')).toMatchObject({
    stdout: 'called\n0\n',
  });
  expect(run('begin; p 0[("a"..)]; rescue => e; p e.class; end')).toMatchObject({ stdout: 'TypeError\n' });
});

test('Integer iteration yields against NaN until the block breaks', () => {
  expect(run('1.upto(Float::NAN){|x|p x;break};1.downto(Float::NAN){|x|p x;break}')).toMatchObject({
    stdout: '1\n1\n',
  });
});

test('String substitutions retain binary source and replacement bytes', () => {
  for (const method of ['sub', 'gsub', 'gsub!']) {
    expect(run(`p 255.chr.${method}("", "-").bytes`)).toMatchObject({
      stdout: method === 'sub' ? '[45, 255]\n' : '[45, 255, 45]\n',
    });
  }
  expect(run('p "a".gsub("a") { 255.chr }.bytes, "a".gsub("a", 255.chr).bytes')).toMatchObject({
    stdout: '[255]\n[255]\n',
  });
  expect(run('begin; "éa".gsub("a", 255.chr); rescue => e; p e.class; end')).toMatchObject({
    stdout: 'Encoding::CompatibilityError\n',
  });
});

test('empty String scan retains original match count across equal-byte edits', () => {
  expect(run('s="bbaa";i=0;s.scan(""){i+=1;s[0,2]="é" if i==1};p i')).toMatchObject({ stdout: '5\n' });
  expect(run('s="éaaa";i=0;s.scan(""){i+=1;s[0]="bb" if i==1};p i')).toMatchObject({ stdout: '5\n' });
  expect(run('s="aaaa";i=0;s.scan(""){i+=1;s[1,2]="é" if i==1};p i')).toMatchObject({ stdout: '4\n' });
  expect(run('s="aaaaa";i=0;s.scan(""){i+=1;s[2,2]="é" if i==1};p i')).toMatchObject({ stdout: '5\n' });
});

test('endless String ranges retain binary bytes', () => {
  expect(run('p (233.chr..).first(2).map{|x|x.bytes}')).toMatchObject({ stdout: '[[233], [234]]\n' });
  expect(run('p (255.chr..).first(2).map{|x|x.bytes}')).toMatchObject({ stdout: '[[255], [1, 0]]\n' });
  expect(run('p 233.chr.succ.bytes, 255.chr.succ.bytes')).toMatchObject({ stdout: '[234]\n[1, 0]\n' });
  expect(run('p (129.chr+255.chr).succ.bytes, ("a"+255.chr).succ.bytes')).toMatchObject({
    stdout: '[130, 0]\n[98, 255]\n',
  });
});

test('inclusive custom Ranges stop before the endpoint successor', () => {
  expect(
    run('class A; def <=>(o); 0; end; def succ; puts :succ; raise "bad"; end; end; a=A.new; (a..a).each{puts :yield}')
  ).toMatchObject({
    stdout: 'yield\n',
  });
});

test('numeric Ranges reject unordered endpoints during construction', () => {
  expect(run('begin; p (1..Float::NAN).size; rescue => e; p e.class,e.message; end')).toMatchObject({
    stdout: 'ArgumentError\n"bad value for range"\n',
  });
  expect(run('begin; Range.new(Float::NAN, 1); rescue => e; p e.class; end')).toMatchObject({
    stdout: 'ArgumentError\n',
  });
});

test('binary String transforms retain bytes and use ASCII case mapping', () => {
  expect(run('p 233.chr.upcase.bytes, 233.chr.chomp.bytes, 233.chr.succ.bytes')).toMatchObject({
    stdout: '[233]\n[233]\n[234]\n',
  });
  expect(run('s=233.chr; s.upcase!; p s.bytes')).toMatchObject({ stdout: '[233]\n' });
});

test('Ruby Strings retain UTF-8 BOM characters from literals and escapes', () => {
  expect(run(String.raw`p "\u{feff}a".bytes, "a\xEF\xBB\xBFb".bytes`)).toMatchObject({
    stdout: '[239, 187, 191, 97]\n[97, 239, 187, 191, 98]\n',
  });
});

test('implicit conversions use methods on reopened immediate classes', () => {
  expect(run('class TrueClass;def to_int;1;end;end;p [9,8][true]')).toMatchObject({ stdout: '8\n' });
  expect(run('class Symbol;def to_str;"!";end;end;p "a"+:x')).toMatchObject({ stdout: '"a!"\n' });
  expect(run('class NilClass;def to_int;1;end;end;begin;p [9,8][nil];rescue=>e;p e.class;end')).toMatchObject({
    stdout: 'TypeError\n',
  });
});

test('shared comparisons honor numeric coercion', () => {
  expect(run('class A;def coerce(x);[x,2];end;end;p [1,A.new].sort.map{|x|x.class}')).toMatchObject({
    stdout: '[Integer, A]\n',
  });
});

test('Hash inspection rejects insertion from child callbacks', () => {
  expect(
    run(
      'class A;def inspect;$h[:b]=2;"x";end;end;$h={a:A.new};begin;p $h.inspect;rescue=>e;p e.class,e.message;end;p $h.size'
    )
  ).toMatchObject({
    stdout: 'RuntimeError\n"can\'t add a new key into hash during iteration"\n1\n',
  });
});

test('Array inspection follows changes from element callbacks', () => {
  expect(run('class A;def inspect;$a.clear;"x";end;end;$a=[A.new,2,3];p $a.inspect,$a')).toMatchObject({
    stdout: '"[x]"\n[]\n',
  });
});

test('p escapes binary inspect results before writing to replacement stdout', () => {
  expect(
    run(
      'class A;def inspect;255.chr;end;end;class W;def write(x);$v<<x;end;end;$v=[];$stdout=W.new;p A.new;$stdout=STDOUT;p $v[0].bytes'
    )
  ).toMatchObject({
    stdout: '[92, 120, 70, 70]\n',
  });
});

test('puts follows Array mutations during element conversion', () => {
  expect(run('class X;def to_s;$a.clear;"x";end;end;$a=[X.new,2,3];puts $a')).toMatchObject({
    stdout: 'x\n',
  });
});

test('putc passes original bytes to write-only stdout', () => {
  expect(
    run('class W;def write(s);$v<<s.bytes;end;end;$v=[];$stdout=W.new;putc 255;putc 233.chr;$stdout=STDOUT;p $v')
  ).toMatchObject({
    stdout: '[[255], [233]]\n',
  });
});

test('print reads the current field separator after writer callbacks', () => {
  expect(
    run(
      'class W;def write(x);$v<<x;$,="-" if x==1;end;end;$v=[];$,=":";$stdout=W.new;print 1,2,3;$stdout=STDOUT;$,=nil;p $v'
    )
  ).toMatchObject({
    stdout: '[1, "-", 2, "-", 3]\n',
  });
});

test('p keeps each value and newline on one selected stream', () => {
  expect(
    run(
      'class W;def initialize(n);@n=n;end;def write(x);$v<<[@n,x];$stdout=$b if @n==1;end;end;$v=[];$b=W.new(2);$stdout=W.new(1);p 1,2;$stdout=STDOUT;p $v'
    )
  ).toMatchObject({
    stdout: '[[1, "1"], [1, "\\n"], [2, "2"], [2, "\\n"]]\n',
  });
});

test('puts decides newline before writer mutates the String', () => {
  expect(
    run(
      String.raw`class W;def write(s);$v<<s.dup;s<<"\n" if s=="x";end;end;$v=[];$stdout=W.new;puts "x";$stdout=STDOUT;p $v`
    )
  ).toMatchObject({
    stdout: '["x", "\\n"]\n',
  });
});

test('pp inspects binary and invalid UTF-8 String bytes', () => {
  expect(run('pp 255.chr')).toMatchObject({ stdout: '"\\xFF"\n' });
  expect(run(String.raw`pp "\xFF"`)).toMatchObject({ stdout: '"\\xFF"\n' });
});

test('pp guards Hash entries during callback inspection', () => {
  expect(
    run('class A;def inspect;$h[:b]=2;"x";end;end;$h={a:A.new};begin;pp $h;rescue=>e;p e.class;end;p $h.size')
  ).toMatchObject({
    stdout: '{a:RuntimeError\n1\n',
  });
  expect(
    run(
      'class A;def inspect;"x";end;end;class W;def write(s);raise "bad";end;end;h={a:A.new};$stdout=W.new;begin;pp h;rescue;end;$stdout=STDOUT;h[:b]=2;p h.size'
    )
  ).toMatchObject({
    stdout: '2\n',
  });
  expect(
    run(
      'class A;def inspect;$h[:b]=2;"x";end;end;class B;def inspect;"y";end;end;$h={a:A.new,c:B.new};begin;pp $h;rescue=>e;p e.class;end;p $h.size'
    )
  ).toMatchObject({ stdout: '{a:RuntimeError\n2\n' });
});

test('pp reads replacement Hash values after earlier inspect callbacks', () => {
  expect(
    run('class A;def inspect;$h[:b]=9;"x";end;end;class B;def inspect;"y";end;end;$h={a:A.new,b:B.new};pp $h;p $h[:b]')
  ).toMatchObject({ stdout: '{a: x, b: 9}\n9\n' });
});

test('pp streams repeated inspect values within the execution budget', () => {
  vi.restoreAllMocks();
  const result = run('class A;def inspect;"x";end;end;pp Array.new(2000,A.new)');
  expect(result).toMatchObject({ kind: 'executed' });
  if (result.kind === 'executed') expect(result.stdout).toHaveLength(8000);
});

test('pp bounds deferred inspect text before retaining more callbacks', () => {
  expect(run('class A;def inspect;"x"*60000;end;end;pp Array.new(100,A.new)')).toEqual({
    kind: 'limitExceeded',
    limit: 'output',
  });
});

test('String concat validates Integer characters before later conversions', () => {
  expect(
    run('class A;def to_str;puts :side;"a";end;end;begin;"".concat(-1,A.new);rescue=>e;p e.class;end')
  ).toMatchObject({ stdout: 'RangeError\n' });
});

test('Set symmetric difference hashes each yielded member before the next yield', () => {
  expect(
    run(
      'class K;def hash;puts :hash;0;end;end;class E;include Enumerable;def each;yield K.new;raise "later";end;end;s=Set.new;puts :start;begin;s^E.new;rescue;puts :rescued;end'
    )
  ).toMatchObject({ stdout: 'start\nhash\nrescued\n' });
});

test('Array flatten handles deep conversion without a host stack overflow', () => {
  expect(run('class A;def to_ary;[self];end;end;p [A.new].flatten(10000).size')).toMatchObject({
    kind: 'executed',
    stdout: '1\n',
  });
});

test('ArithmeticSequence size converts custom Float limits', () => {
  expect(run('class A;private;def to_f;puts :convert;2.0;end;end;p 1.0.step(A.new,0.5).size')).toMatchObject({
    stdout: 'convert\n3\n',
  });
  expect(run('class A;end;begin;p 1.0.step(A.new,0.5).size;rescue=>e;p e.class;end')).toMatchObject({
    stdout: 'TypeError\n',
  });
});

test('Hash lookup uses String key semantics for String subclasses', () => {
  expect(
    run(
      'class S<String;def eql?(x);puts :eq;true;end;def hash;puts :hash;1.hash;end;end;s=S.new("x");h={1=>42};puts :lookup;p h[s]'
    )
  ).toMatchObject({ stdout: 'lookup\nnil\n' });
});

test('pp permits changes to a later Hash and omits deleted entries', () => {
  expect(
    run(
      'class A;def inspect;$h[:new]=2;"x";end;end;class B;def inspect;"y";end;end;$h={a:1};pp [A.new,$h,B.new];p $h.size'
    )
  ).toMatchObject({ stdout: '[x, {a: 1, new: 2}, y]\n2\n' });
  expect(
    run(
      'class A;def inspect;$h.delete(:b);"x";end;end;class B;def inspect;"y";end;end;$h={a:A.new,b:B.new};pp $h;p $h.size'
    )
  ).toMatchObject({ stdout: '{a: x}\n1\n' });
});

test('pp streams a large unchanged callback collection within the time budget', () => {
  vi.restoreAllMocks();
  const result = run('class A;def inspect;"x";end;end;pp Array.new(10000,A.new)');
  expect(result).toMatchObject({ kind: 'executed' });
  if (result.kind === 'executed') expect(result.stdout).toHaveLength(40_000);
});

test('join recursively handles Array subclasses after its preflight', () => {
  expect(run('class A<Array;def to_str;puts :str;"x";end;end;p [A.new([1,2])].join(",")')).toMatchObject({
    stdout: 'str\n"1,2"\n',
  });
});

test('character formatting validates native int bounds', () => {
  expect(run('begin;p format("%c",-2147483649);rescue=>e;p e.class,e.message;end')).toMatchObject({
    stdout: 'RangeError\n"integer -2147483649 too small to convert to \'int\'"\n',
  });
});

test('Array assignment reports exact and oversized indexes', () => {
  expect(run('a=[1];begin;a[-9007199254740993]=1;rescue=>e;p e.message;end')).toMatchObject({
    stdout: '"index -9007199254740993 too small for array; minimum: -1"\n',
  });
  expect(run('a=[1];begin;a[9223372036854775807]=1;rescue=>e;p e.class,e.message;end')).toMatchObject({
    stdout: 'IndexError\n"index 9223372036854775807 too big"\n',
  });
});

test('Kernel Integer accepts negative radices and source prefixes', () => {
  expect(
    run('p Integer("10",-1),Integer("10",-2),Integer("10",-16),Integer("10",-36),Integer("0xff",-2)')
  ).toMatchObject({
    stdout: '10\n2\n16\n36\n255\n',
  });
  expect(run('begin;p "10".to_i(-1);rescue=>e;p e.class;end')).toMatchObject({ stdout: 'ArgumentError\n' });
});

test('ArithmeticSequence size converts custom limits for Float receivers', () => {
  expect(run('class A;def to_f;puts :converted;3.0;end;end;p 1.0.step(A.new,1).size')).toMatchObject({
    stdout: 'converted\n3\n',
  });
});

test('Array equality observes shrinkage during element callbacks', () => {
  expect(run('class X;def ==(v);$b.clear;true;end;end;$a=[X.new,1];$b=[0,1];p $a==$b')).toMatchObject({
    stdout: 'false\n',
  });
  expect(run('class X;def ==(v);$a.clear;true;end;end;$a=[X.new,1];$b=[0,1];p $a==$b')).toMatchObject({
    stdout: 'false\n',
  });
});

test('Array spaceship returns the element comparison value', () => {
  expect(run('class X;def <=>(x);42;end;end;p [X.new]<=>[0]')).toMatchObject({ stdout: '42\n' });
  expect(run('class X;def <=>(x);Float::NAN;end;end;p [X.new]<=>[0]')).toMatchObject({ stdout: 'NaN\n' });
});

test('Hash assignment rechecks freezing after key callbacks', () => {
  expect(
    run('class K;def hash;$h.freeze;0;end;end;$h={};begin;$h[K.new]=1;rescue=>e;p e.class;end;p $h.size')
  ).toMatchObject({ stdout: 'FrozenError\n0\n' });
});

test('character formatting uses implicit String and Integer conversions', () => {
  expect(run('class A;private;def to_str;"x";end;end;p format("%c",A.new)')).toMatchObject({ stdout: '"x"\n' });
  expect(run('class A;private;def to_int;65;end;end;p format("%c",A.new)')).toMatchObject({ stdout: '"A"\n' });
});

test('Random Float zero bounds draw from the default range', () => {
  expect(run('p Random.new(1).rand(0.0),Random.new(1).rand(-0.0)')).toMatchObject({
    stdout: '0.417022004702574\n0.417022004702574\n',
  });
});

test('Array equality follows live lengths after matching callbacks', () => {
  expect(run('class X;def ==(x);$a<<3;$b<<3;true;end;end;$a=[X.new,1];$b=[0,1];p $a==$b')).toMatchObject({
    stdout: 'true\n',
  });
  expect(run('class X;def ==(x);$a.clear;$b.clear;true;end;end;$a=[X.new,1];$b=[0,1];p $a==$b')).toMatchObject({
    stdout: 'true\n',
  });
});

test('Array spaceship continues only for Integer zero', () => {
  expect(run('class X;def <=>(x);0.0;end;end;p [X.new,1]<=>[0,2]')).toMatchObject({ stdout: '0.0\n' });
});

test('Random draws from custom arithmetic ranges', () => {
  expect(
    run(
      'class A;attr_reader :n;def initialize(n);@n=n;end;def <=>(o);n<=>o.n;end;def -(o);n-o.n;end;def +(x);n+x;end;end;p Random.new(1).rand(A.new(1)..A.new(3))'
    )
  ).toMatchObject({ stdout: '2\n' });
});

test('Integer Range sum converts a custom initial value', () => {
  expect(
    run('class A;def +(x);puts :add;self;end;end;begin;p (1..3).sum(A.new);rescue=>e;p e.class;end')
  ).toMatchObject({
    stdout: 'TypeError\n',
  });
  expect(run('class A;private;def to_f;2.5;end;end;p (1..3).sum(A.new)')).toMatchObject({ stdout: '8.5\n' });
});

test('Range step accepts numeric-like custom increments', () => {
  expect(run('class N;private;def coerce(x);[x,2];end;end;p (1..5).step(N.new).first(4)')).toMatchObject({
    stdout: '[1, 3, 5]\n',
  });
});

test('custom Range step stops when its first successor does not advance', () => {
  const source = `class A
  attr_reader :n
  def initialize(n); @n=n; end
  def <=>(x); return nil if @n==0 && x.n==1; @n<=>x.n; end
  def +(x); A.new(@n+x); end
end
(A.new(0)..A.new(3)).step(1){|x|p x.n}
puts :done`;
  expect(run(source)).toMatchObject({ stdout: 'done\n' });
  expect(
    run(
      'class A;attr_reader :n;def initialize(n);@n=n;end;def <=>(x);n<=>x.n;end;def +(x);self;end;end;(A.new(0)..A.new(3)).step(1){puts :yielded};puts :done'
    )
  ).toMatchObject({
    stdout: 'done\n',
  });
});

test('binary search rejects NaN comparison results', () => {
  expect(run('begin;p (1..5).bsearch{Float::NAN};rescue=>e;p e.class,e.message;end')).toMatchObject({
    stdout: 'ArgumentError\n"comparison of Float with 0 failed"\n',
  });
  expect(run('begin;p [1,2,3].bsearch{Float::NAN};rescue=>e;p e.class;end')).toMatchObject({
    stdout: 'ArgumentError\n',
  });
});

test('Range step with NaN yields no values', () => {
  expect(run('p (1..3).step(Float::NAN).to_a')).toMatchObject({ stdout: '[]\n' });
});

test('repeated String sizes count characters without allocating them', () => {
  expect(run('s="x"*100000;10.times{p s.size}')).toMatchObject({
    kind: 'executed',
    stdout: '100000\n'.repeat(10),
  });
  expect(run('s="x"*100000;10.times{p s.each_char.size}')).toMatchObject({
    kind: 'executed',
    stdout: '100000\n'.repeat(10),
  });
});

test('empty Array repeated selection sizes short-circuit', () => {
  expect(run('p [].repeated_combination(1000001).size,[].repeated_permutation(1000001).size')).toMatchObject({
    stdout: '0\n0\n',
  });
});

test('Enumerator sizes convert count arguments when queried', () => {
  expect(
    run('class A;def to_int;puts :called;2;end;end;e=[1,2,3].each_slice(A.new);puts :size;p e.size')
  ).toMatchObject({ stdout: 'called\nsize\ncalled\n2\n' });
  expect(run('p [1,2,3].permutation(2.5).size,[1,2].cycle(2.5).size')).toMatchObject({
    stdout: '6\n4\n',
  });
});

test('custom Numeric step limits use a generic Enumerator', () => {
  expect(
    run('class A;def to_f;3.0;end;end;e=1.0.step(A.new,0.5);p e.class;begin;p e.last;rescue=>x;p x.class;end')
  ).toMatchObject({ stdout: 'Enumerator\nNoMethodError\n' });
});

test('Range construction invokes String subclass comparison', () => {
  expect(
    run('class S<String;def <=>(x);puts :cmp;nil;end;end;begin;p (S.new("a")..S.new("b"));rescue=>e;p e.class;end')
  ).toMatchObject({ stdout: 'cmp\nArgumentError\n' });
});

test('custom Range endpoints receive arbitrary step values', () => {
  expect(
    run(
      'class A;attr_reader :n;def initialize(n);@n=n;end;def <=>(x);n<=>x.n;end;def +(x);A.new(n+1);end;end;(A.new(0)..A.new(2)).step(Object.new){|x|p x.n}'
    )
  ).toMatchObject({ stdout: '0\n1\n2\n' });
});

test('Integer Range sum uses Float conversion for String and nil initial values', () => {
  expect(run('p (1..3).sum("2.5")')).toMatchObject({ stdout: '8.5\n' });
  expect(run('begin;p (1..3).sum(nil);rescue=>e;p e.class;end')).toMatchObject({ stdout: 'TypeError\n' });
});

test('Enumerator grouping sizes validate renewed count conversions', () => {
  expect(
    run(
      'class A;def initialize;@n=1;end;def to_int;x=@n;@n=0;x;end;end;e=[1,2].each_slice(A.new);begin;p e.size;rescue=>e;p e.class;end'
    )
  ).toMatchObject({ stdout: 'ArgumentError\n' });
  expect(
    run(
      'class A;def initialize;@n=1;end;def to_int;x=@n;@n=-1;x;end;end;e=[1,2].each_cons(A.new);begin;p e.size;rescue=>e;p e.class;end'
    )
  ).toMatchObject({ stdout: 'ArgumentError\n' });
});

test('empty cycle size skips count conversion', () => {
  expect(run('class A;def to_int;puts :called;2;end;end;e=[].cycle(A.new);puts :size;p e.size')).toMatchObject({
    stdout: 'size\n0\n',
  });
});

test('rescue class evaluation stops after a match', () => {
  expect(
    run('def f;puts :later;StandardError;end;begin;raise "x";rescue StandardError,f;puts :handled;end')
  ).toMatchObject({
    stdout: 'handled\n',
  });
});

test('distinct Symbols receive distinct object IDs', () => {
  expect(run('p :Aa.object_id == :BB.object_id, :ab.object_id == :bC.object_id')).toMatchObject({
    stdout: 'false\nfalse\n',
  });
});

test('copied classes and modules have independent identities and methods', () => {
  expect(
    run('class A;end;B=A.dup;class B;def x;2;end;end;begin;p A.new.x;rescue=>e;p e.class;end;p B.new.x')
  ).toMatchObject({ stdout: 'NoMethodError\n2\n' });
  expect(run('module M;end;p M.dup == M')).toMatchObject({ stdout: 'false\n' });
});

test('copied Procs retain behavior with independent identity and freezing', () => {
  expect(run('p=proc{2};q=p.dup;q.freeze;p p.frozen?,p.equal?(q),q.call')).toMatchObject({
    stdout: 'false\nfalse\n2\n',
  });
});

test('Range copies have distinct identity and Ruby frozen states', () => {
  expect(run('a=1..3;b=a.dup;c=a.clone;p a.equal?(b),a.equal?(c),a.frozen?,b.frozen?,c.frozen?')).toMatchObject({
    stdout: 'false\nfalse\ntrue\nfalse\ntrue\n',
  });
});

test('clone validates positional and keyword arguments', () => {
  expect(run('begin;p "x".clone(1);rescue=>e;p e.class,e.message;end')).toMatchObject({
    stdout: 'ArgumentError\n"wrong number of arguments (given 1, expected 0)"\n',
  });
  expect(run('begin;p "x".clone(foo:1);rescue=>e;p e.class;end')).toMatchObject({ stdout: 'ArgumentError\n' });
});

test('raise validates explicit causes and cause-only calls', () => {
  expect(run('begin;raise "x",cause:1;rescue=>e;p e.class,e.message;end')).toMatchObject({
    stdout: 'TypeError\n"exception object expected"\n',
  });
  expect(run('begin;raise cause:nil;rescue=>e;p e.class,e.message;end')).toMatchObject({
    stdout: 'ArgumentError\n"only cause is given with no arguments"\n',
  });
});

test('raise rejects unsupported explicit backtraces', () => {
  expect(run('begin;raise RuntimeError,"x",["fake:1"];rescue=>e;puts :caught;end')).toMatchObject({
    uncaughtException: 'raise backtrace は、この採点環境では使えません。',
  });
});

test('Kernel String invokes private implicit conversions', () => {
  expect(run('class A;private;def to_str;"yes";end;public;def to_s;"no";end;end;p String(A.new)')).toMatchObject({
    stdout: '"yes"\n',
  });
  expect(run('class A;private;def to_s;"yes";end;end;p String(A.new)')).toMatchObject({ stdout: '"yes"\n' });
});

test('exit! cannot be rescued as SystemExit', () => {
  expect(run('begin;exit!;rescue Exception;puts :alive;end')).toMatchObject({
    uncaughtException: 'Kernel#exit! は、この採点環境では使えません。',
  });
});

test('exit converts statuses before raising SystemExit', () => {
  expect(run('begin;exit "bad";rescue Exception=>e;p e.class,e.message;end')).toMatchObject({
    stdout: 'TypeError\n"no implicit conversion of String into Integer"\n',
  });
  expect(
    run('class A;def to_int;puts :converted;7;end;end;begin;exit A.new;rescue SystemExit=>e;p e.status;end')
  ).toMatchObject({ stdout: 'converted\n7\n' });
});

test('copied class methods use the copy’s lexical constants', () => {
  expect(run('class A;X=1;def x;X;end;end;B=A.dup;B::X=2;p A.new.x,B.new.x')).toMatchObject({
    stdout: '1\n2\n',
  });
});

test('catch and throw distinguish signed Float zero tags', () => {
  expect(run('begin;p catch(-0.0){throw 0.0,7};rescue=>e;p e.class;end')).toMatchObject({
    stdout: 'UncaughtThrowError\n',
  });
});

test('default inclusion rejects a duplicate module on a frozen class', () => {
  expect(
    run('module M;end;class C;include M;end;C.freeze;begin;C.include(M);puts :ok;rescue=>e;p e.class;end')
  ).toMatchObject({
    stdout: 'FrozenError\n',
  });
});

test('method visibility names expand only one Array level', () => {
  expect(run('class C;a=[];a<<a;begin;private a;rescue=>e;p e.class;end;end')).toMatchObject({
    stdout: 'TypeError\n',
  });
  expect(run('class C;begin;attr_reader [:x];rescue=>e;p e.class;end;end')).toMatchObject({
    stdout: 'TypeError\n',
  });
});

test('Class new runs inherited before its definition block', () => {
  expect(run('class A;def self.inherited(x);puts :inherited;end;end;B=Class.new(A){puts :body}')).toMatchObject({
    stdout: 'inherited\nbody\n',
  });
});

test('Class new blocks define methods with their visibility', () => {
  expect(run('c=Class.new do;def x;1;end;end;p c.new.x')).toMatchObject({ stdout: '1\n' });
  expect(run('c=Class.new do;private;attr_reader :x;end;begin;c.new.x;rescue=>e;p e.class;end')).toMatchObject({
    stdout: 'NoMethodError\n',
  });
});

test('Module attr accepts an optional writer flag', () => {
  expect(run('class C;attr :x,true;end;c=C.new;c.x=1;p c.x')).toMatchObject({ stdout: '1\n' });
  expect(run('class C;attr :x,false;end;p C.new.x;begin;C.new.x=1;rescue=>e;p e.class;end')).toMatchObject({
    stdout: 'nil\nNoMethodError\n',
  });
});

test('classes do not inherit module_function', () => {
  expect(run('class C;def x;end;begin;module_function :x;rescue=>e;p e.class;end;end')).toMatchObject({
    stdout: 'NoMethodError\n',
  });
});

test('frozen module inclusion checks freezing before cycles', () => {
  expect(run('module M;end;M.freeze;begin;M.include(M);rescue=>e;p e.class,e.message;end')).toMatchObject({
    stdout: 'FrozenError\n"can\'t modify frozen Module: M"\n',
  });
});

test('Exception message preserves binary String bytes', () => {
  expect(run('p Exception.new(255.chr).message.bytes')).toMatchObject({ stdout: '[255]\n' });
});

test('detailed exception messages report unsupported behavior', () => {
  expect(run('p RuntimeError.new("oops").detailed_message')).toMatchObject({
    uncaughtException: 'Exception#detailed_message は、この採点環境では使えません。',
  });
});

test('lambda curry validates explicit positional arity', () => {
  expect(
    run('f=->(x,y){x+y};begin;f.curry(1);rescue=>e;p e.class;end;begin;f.curry(3);rescue=>e;p e.class;end')
  ).toMatchObject({
    stdout: 'ArgumentError\nArgumentError\n',
  });
});

test('Proc creators without blocks raise ArgumentError', () => {
  expect(
    run(
      'begin;Proc.new;rescue=>e;p e.class,e.message;end;begin;proc;rescue=>e;p e.class,e.message;end;begin;lambda;rescue=>e;p e.class,e.message;end'
    )
  ).toMatchObject({
    stdout: 'ArgumentError\n"tried to create Proc object without a block"\n'.repeat(3),
  });
});

test('module declarations convert string-like method names', () => {
  expect(
    run('class A;private;def to_str;"x";end;end;class C;attr_accessor A.new;end;c=C.new;c.x=2;p c.x')
  ).toMatchObject({ stdout: '2\n' });
});

test('top-level visibility applies to later Object methods', () => {
  expect(
    run('public;def f;1;end;p Object.new.f;private;def g;2;end;begin;Object.new.g;rescue=>e;p e.class;end')
  ).toMatchObject({
    stdout: '1\nNoMethodError\n',
  });
});

test('IO receivers keep Kernel p private', () => {
  expect(run('begin;STDOUT.p 1;rescue=>e;p e.class;end')).toMatchObject({ stdout: 'NoMethodError\n' });
});

test('IO sync remembers each output stream’s assigned state', () => {
  expect(
    run('STDOUT.sync=false;p STDOUT.sync;STDOUT.sync=true;p STDOUT.sync;STDERR.sync=false;p STDERR.sync')
  ).toMatchObject({
    stdout: 'false\ntrue\nfalse\n',
  });
});

test('Exception message returns an overridden to_s result unchanged', () => {
  expect(run('class E<StandardError;def to_s;7;end;end;p E.new.message')).toMatchObject({ stdout: '7\n' });
  expect(run('class E<StandardError;def to_s;nil;end;end;p E.new.message')).toMatchObject({ stdout: 'nil\n' });
});

test('Exception to_s validates message object conversion', () => {
  expect(run('class A;def to_s;7;end;end;begin;p Exception.new(A.new).to_s;rescue=>e;p e.class;end')).toMatchObject({
    stdout: 'TypeError\n',
  });
});

test('numeric and immediate clones validate arguments and freezing', () => {
  expect(run('begin;1.clone(1);rescue=>e;p e.class;end;begin;1.0.clone(foo:1);rescue=>e;p e.class;end')).toMatchObject({
    stdout: 'ArgumentError\nArgumentError\n',
  });
  expect(run('begin;nil.clone(freeze:false);rescue=>e;p e.class,e.message;end')).toMatchObject({
    stdout: 'ArgumentError\n"can\'t unfreeze NilClass"\n',
  });
});

test('Numeric step accepts numeric-like custom increments', () => {
  expect(
    run(
      'class N;def coerce(x);[x,2];end;def >(x);true;end;def <(x);false;end;def ==(x);false;end;end;p 1.step(5,N.new).first(4)'
    )
  ).toMatchObject({ stdout: '[1, 3, 5]\n' });
});

test('Integer gcd charges large Euclidean divisions to the execution budget', () => {
  const program =
    'a=0;b=1;100000.to_s(2).each_char{|c|x=a*(2*b-a);y=a*a+b*b;if c=="0";a=x;b=y;else;a=y;b=x+y;end};p a.gcd(b)';
  expect(run(program)).toEqual({ kind: 'limitExceeded', limit: 'operations' });
});

test('Integer iteration compares numeric-like custom limits', () => {
  expect(run('class A;def coerce(x);[x,3];end;end;1.upto(A.new){|x|p x}')).toMatchObject({
    stdout: '1\n2\n3\n',
  });
  expect(run('class A;def coerce(x);[x,2];end;end;3.downto(A.new){|x|p x}')).toMatchObject({
    stdout: '3\n2\n',
  });
});

test('rounding accepts mixed-case implicit String modes', () => {
  expect(run('p 2.5.round(half:"UP"),2.5.round(half:"EvEn")')).toMatchObject({ stdout: '3\n2\n' });
  expect(run('class A;private;def to_str;"EvEn";end;end;p 2.5.round(half:A.new)')).toMatchObject({
    stdout: '2\n',
  });
  expect(
    run('class A;private;def to_str;nil;end;end;begin;2.5.round(half:A.new);rescue=>e;p e.class;end')
  ).toMatchObject({
    stdout: 'ArgumentError\n',
  });
});

test('Numeric step validates custom zero increments', () => {
  expect(
    run(
      'class N;def coerce(x);[x,0];end;def >(x);false;end;def ==(x);true;end;end;begin;1.step(3,N.new).first(3);rescue=>e;p e.class;end'
    )
  ).toMatchObject({ stdout: 'ArgumentError\n' });
  expect(run('class N;def ==(x);puts :eq;true;end;end;begin;1.step(3,N.new);rescue=>e;p e.class;end')).toMatchObject({
    stdout: 'eq\nArgumentError\n',
  });
});

test('Integer Range compares numeric-like ends', () => {
  expect(run('class A;private;def coerce(x);[x,3];end;end;p (1..A.new).to_a')).toMatchObject({
    stdout: '[1, 2, 3]\n',
  });
});

test('binary search accepts Numeric comparison values', () => {
  expect(run('class N<Numeric;def <=>(x);0;end;end;p (1..5).bsearch{N.new},[1,2,3].bsearch{N.new}')).toMatchObject({
    stdout: '3\n2\n',
  });
});

test('boxed Float endpoints preserve Range and arithmetic sequence behavior', () => {
  expect(
    run('p (1..Float::INFINITY).first(2),(1..3).step(Float::INFINITY).class,(1..3).step(Float::INFINITY).size')
  ).toMatchObject({
    stdout: '[1, 2]\nEnumerator::ArithmeticSequence\n1\n',
  });
});

test('numeric Range steps support descending and infinite increments', () => {
  expect(run('p (3..1).step(-1).to_a,(3.0...1.0).step(-1.0).to_a')).toMatchObject({
    stdout: '[3, 2, 1]\n[3.0, 2.0]\n',
  });
  expect(run('p (1..3).step(Float::INFINITY).to_a,(1.0...2.0).step(Float::INFINITY).to_a')).toMatchObject({
    stdout: '[1.0]\n[1.0]\n',
  });
});

test('boxed Float keyword step limits produce Float sequence values', () => {
  expect(run('p 1.step(to:Float::INFINITY,by:1).first(2)')).toMatchObject({
    stdout: '[1.0, 2.0]\n',
  });
});

test('uncaught exception description falls back for non-String messages', () => {
  expect(run('class E<StandardError;def message;7;end;end;raise E')).toMatchObject({ uncaughtException: 'E' });
});

test('allocated Floats preserve separate object identities', () => {
  expect(run('a=Float::NAN;b=0.0/0.0;p a.equal?(b),a.object_id==b.object_id,a.equal?(a)')).toMatchObject({
    stdout: 'false\nfalse\ntrue\n',
  });
  expect(run('a=Float::INFINITY;b=1.0/0.0;p a.equal?(b),a.object_id==b.object_id')).toMatchObject({
    stdout: 'false\nfalse\n',
  });
  expect(run('a=Float::MAX;b=Float::MAX*1;p a.equal?(b),a.object_id==b.object_id')).toMatchObject({
    stdout: 'false\nfalse\n',
  });
  expect(run('a=Float::NAN;p a.to_f.equal?(a),a.dup.equal?(a)')).toMatchObject({ stdout: 'true\ntrue\n' });
  expect(run('a=Float::MAX;b=a*1.0;p a.eql?(b),[a].eql?([b])')).toMatchObject({ stdout: 'true\ntrue\n' });
});

test('numeric callbacks receive the original allocated Float', () => {
  expect(run('class A;def coerce(x);p x.equal?($f);[1,2];end;end;$f=Float::MAX;p($f+A.new)')).toMatchObject({
    stdout: 'true\n3\n',
  });
});

test('boxed Floats preserve numeric sorting, summation, and random ranges', () => {
  expect(run('p (0..31).to_a.sort_by{|x|x%3==0 ? Float::MAX : 1.0}.first(4)')).toMatchObject({
    stdout: '[31, 29, 28, 26]\n',
  });
  expect(run('p [Float::MAX,1.0,-Float::MAX].sum')).toMatchObject({ stdout: '1.0\n' });
  expect(run('p Random.new(1).rand(0.0..Float::MAX)')).toMatchObject({ stdout: '7.496775840943564e+307\n' });
  expect(run('begin;Random.new(1).rand(0.0..Float::INFINITY);rescue=>e;p e.class;end')).toMatchObject({
    stdout: 'Errno::EDOM\n',
  });
});

test('pp follows Array mutations during element inspection', () => {
  expect(run('class A;def inspect;$a.clear;"x";end;end;$a=[A.new,2,3];pp $a')).toMatchObject({ stdout: '[x]\n' });
  expect(
    run('class A;def inspect;$a.clear;"x";end;end;class B;def inspect;puts :two;"y";end;end;$a=[A.new,B.new];pp $a')
  ).toMatchObject({
    stdout: '[x]\n',
  });
});

test('pp emits container prefixes before user inspect callbacks', () => {
  expect(run('class A;def inspect;puts :side;"a";end;end;pp [A.new]')).toMatchObject({
    stdout: '[side\na]\n',
  });
  expect(run('class A;def inspect;puts :side;"a";end;end;pp [1,A.new]')).toMatchObject({
    stdout: '[1,side\n a]\n',
  });
  expect(run('class A;def inspect;puts :side;"a";end;end;pp ["x"*76,A.new]')).toMatchObject({
    stdout: `["${'x'.repeat(76)}",\n side\na]\n`,
  });
  expect(run('class A;def inspect;"x";end;end;pp [[1,A.new]], [{a:A.new}]')).toMatchObject({
    stdout: '[[1, x]]\n[{a: x}]\n',
  });
});

test('pp breaks all separators in a streamed group that cannot fit', () => {
  expect(run('class A;def inspect;"x";end;end;pp [A.new,"a"*80,1,2]')).toMatchObject({
    stdout: `[x,\n "${'a'.repeat(80)}",\n 1,\n 2]\n`,
  });
  expect(run('class A;def inspect;"x";end;end;pp({one:"a"*60,two:A.new,three:2})')).toMatchObject({
    stdout: `{one: "${'a'.repeat(60)}",\n two: x,\n three: 2}\n`,
  });
  expect(run('class A;def inspect;"x"*80;end;end;pp [1,A.new,2]')).toMatchObject({
    stdout: `[1,\n ${'x'.repeat(80)},\n 2]\n`,
  });
  expect(run('class A;def inspect;"x"*80;end;end;pp({a:1,b:A.new,c:2})')).toMatchObject({
    stdout: `{a: 1,\n b:\n  ${'x'.repeat(80)},\n c: 2}\n`,
  });
  expect(run('class A;def inspect;"x";end;end;a=["z"*40];pp [a,a,A.new]')).toMatchObject({
    stdout: `[["${'z'.repeat(40)}"],\n ["${'z'.repeat(40)}"],\n x]\n`,
  });
  expect(run('class A;def inspect;"x"*70;end;end;pp [1,A.new,A.new]')).toMatchObject({
    stdout: `[1,\n ${'x'.repeat(70)},\n ${'x'.repeat(70)}]\n`,
  });
  expect(run('class A;def inspect;"x"*70;end;end;pp({a:1,b:A.new,c:A.new})')).toMatchObject({
    stdout: `{a: 1,\n b: ${'x'.repeat(70)},\n c: ${'x'.repeat(70)}}\n`,
  });
  expect(
    run('class A;def inspect;puts :one;"x";end;end;class B;def inspect;puts :two;"y";end;end;pp [A.new,B.new,"a"*80,1]')
  ).toMatchObject({
    stdout: `[one\nx,two\n\n y,\n "${'a'.repeat(80)}",\n 1]\n`,
  });
});

test('Integer step compares numeric-like limits through coerce', () => {
  expect(run('class A;private;def coerce(x);[x,3];end;end;p 1.step(A.new).first(2)')).toMatchObject({
    stdout: '[1, 2]\n',
  });
});

test('Float step converts numeric-like limits through to_f', () => {
  expect(run('class A;def to_f;1.6;end;end;p 1.step(A.new,0.5).to_a')).toMatchObject({
    stdout: '[1.0, 1.5]\n',
  });
  expect(
    run('class A;def coerce(x);[x,3];end;end;begin;1.step(A.new,0.5){|x|p x};rescue=>e;p e.class,e.message;end')
  ).toMatchObject({
    stdout: 'TypeError\n"can\'t convert A into Float"\n',
  });
  expect(run('class A;def to_f;puts :converted;0.0;end;end;p 1.0.step(A.new).first')).toMatchObject({
    stdout: 'converted\nnil\n',
  });
  expect(
    run('class A;def coerce(x);[x,3];end;end;begin;p 1.0.step(A.new).first;rescue=>e;p e.class;end')
  ).toMatchObject({
    stdout: 'TypeError\n',
  });
});

test('Kernel numeric conversions invoke private conversion methods', () => {
  expect(run('class A;private;def to_int;12;end;end;p Integer(A.new)')).toMatchObject({ stdout: '12\n' });
  expect(run('class A;private;def to_str;"12";end;end;p Integer(A.new)')).toMatchObject({ stdout: '12\n' });
  expect(run('class A;private;def to_i;12;end;end;p Integer(A.new)')).toMatchObject({ stdout: '12\n' });
  expect(run('class A;private;def to_f;1.5;end;end;p Float(A.new)')).toMatchObject({ stdout: '1.5\n' });
});

test('Float conversion accepts Ruby decimal and hexadecimal text', () => {
  expect(run('p Float(".5e1_0"),Float("-.2e2_1"),Float("1."),Float("1.e2")')).toMatchObject({
    stdout: '5000000000.0\n-2.0e+20\n1.0\n100.0\n',
  });
  expect(run('p Float("0x1.8p1"),Float("0x.1p2"),Float("0x1.")')).toMatchObject({
    stdout: '3.0\n0.25\n1.0\n',
  });
  expect(run('p "1.e2".to_f,"-2.e3".to_f')).toMatchObject({ stdout: '100.0\n-2000.0\n' });
  expect(run('p Float("0x1p-"+"9"*309),Float("-0x1p-"+"9"*309)')).toMatchObject({
    stdout: '0.0\n-0.0\n',
  });
});

test('Float powers handle unit and Complex nonfinite boundaries', () => {
  expect(run('p 1.0**Float::INFINITY,(-1.0)**(-Float::INFINITY),1.0**Float::NAN')).toMatchObject({
    stdout: '1.0\n1.0\n1.0\n',
  });
  expect(run('p (-2.0)**Float::NAN')).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining('使えません'),
  });
});

test('numeric equality honors reopened operand classes', () => {
  expect(run('class String;def ==(x);puts :hit;true;end;end;p 1=="a"')).toMatchObject({
    stdout: 'hit\ntrue\n',
  });
  expect(run('class TrueClass;def ==(x);true;end;end;p 1==true')).toMatchObject({ stdout: 'true\n' });
});

test('container equality skips callbacks for identical values', () => {
  expect(
    run(
      'class X;def ==(x);puts :hit;false;end;end;x=X.new;p [x]==[x], [x].include?(x), [x].index(x), [x].count(x), {a:x}=={a:x}'
    )
  ).toMatchObject({
    stdout: 'true\ntrue\n0\n1\ntrue\n',
  });
});

test('Array bounds use current storage after selector conversions', () => {
  expect(run('class I;def to_int;$a.clear;0;end;end;$a=[1];p $a[I.new]')).toMatchObject({ stdout: 'nil\n' });
  expect(
    run('class I;def to_int;$a.clear;-1;end;end;$a=[1,2,3];begin;$a[I.new]=9;rescue=>e;p e.class;end;p $a')
  ).toMatchObject({
    stdout: 'IndexError\n[]\n',
  });
});

test('Array initializer writes to current storage and checks frozen state', () => {
  expect(run('class A<Array;def initialize;super(3){|i|clear if i==1;i};end;end;p A.new')).toMatchObject({
    stdout: '[nil, 1, 2]\n',
  });
  expect(
    run(
      'class A<Array;def initialize;$a=self;super(3){|i|freeze if i==1;i};end;end;begin;A.new;rescue=>e;p e.class;end;p $a'
    )
  ).toMatchObject({
    stdout: 'FrozenError\n[0]\n',
  });
  expect(
    run('class A<Array;def initialize;super(2){|i|replace([7,8,9,10]) if i==0;p self;i};end;end;p A.new')
  ).toMatchObject({
    stdout: '[7, 8, 9, 10]\n[0]\n[0, 1]\n',
  });
});

test('Array comparison converts array-like values and handles callback shrinkage', () => {
  expect(run('class A;private;def to_ary;[2];end;end;p [1]<=>A.new')).toMatchObject({ stdout: '-1\n' });
  expect(run('class A;def <=>(x);$a.clear;0;end;end;$a=[A.new,2];p $a<=>[0,2]')).toMatchObject({
    stdout: 'nil\n',
  });
});

test('Array join follows receiver mutation during element conversion', () => {
  expect(run('class A;def to_str;$a.replace([8]);"x";end;end;$a=[A.new,2,3];p $a.join(","),$a')).toMatchObject({
    stdout: '"8"\n[8]\n',
  });
  expect(run('class A;def to_ary;$a.clear;[1];end;end;$a=[A.new,2];p $a.join(",")')).toMatchObject({
    stdout: '"1"\n',
  });
  expect(run('class A;def to_str;puts :str;1;end;end;begin;p [A.new].join;rescue=>e;p e.class;end')).toMatchObject({
    stdout: 'str\nTypeError\n',
  });
  expect(run('class A;def to_str;puts :str;"x";end;end;p ["a","b",A.new].join(",")')).toMatchObject({
    stdout: 'str\nstr\n"a,b,x"\n',
  });
  expect(
    run('class A<Array;def to_str;puts :str;1;end;end;begin;p ["a",A.new([1])].join;rescue=>e;p e.class;end')
  ).toMatchObject({
    stdout: 'str\nTypeError\n',
  });
});

test('format checks encoding before later conversion callbacks', () => {
  expect(
    run('class A;def to_s;puts :side;"x";end;end;begin;p format("é%s%s",255.chr,A.new);rescue=>e;p e.class;end')
  ).toMatchObject({
    stdout: 'Encoding::CompatibilityError\n',
  });
});

test('String concat and prepend convert all arguments before encoding checks', () => {
  for (const method of ['concat', 'prepend']) {
    expect(
      run(
        `class A;def to_str;puts :side;"a";end;end;s="é";begin;s.${method}(255.chr,A.new);rescue=>e;p e.class;end;p s`
      )
    ).toMatchObject({
      stdout: 'side\nEncoding::CompatibilityError\n"é"\n',
    });
  }
});

test('Enumerable sum stays generic after Float coercion returns an object', () => {
  expect(
    run('class A;def coerce(x);[self,self];end;def +(x);puts :add;self;end;end;p [A.new,2].sum(0.5).class')
  ).toMatchObject({
    stdout: 'add\nadd\nA\n',
  });
});

test('Array structural hash stops after callback removes later elements', () => {
  expect(
    run(
      'class A;def hash;puts :one;$a.clear;0;end;end;class B;def hash;puts :two;0;end;end;$a=[A.new,B.new];$a.hash;p $a'
    )
  ).toMatchObject({
    stdout: 'one\n[]\n',
  });
});

test('large splats bind without exhausting host call arguments', () => {
  expect(run('def f(*x);p x.size;end;f(*Array.new(300000,1))')).toMatchObject({ stdout: '300000\n' });
  expect(run('p proc{|*x|x.size}.call(*Array.new(300000,1))')).toMatchObject({ stdout: '300000\n' });
});

test('explicit self can call private operators and index methods', () => {
  expect(run('class A; def f; self+1; end; private; def +(x); 42; end; end; p A.new.f')).toMatchObject({
    stdout: '42\n',
  });
  expect(
    run('class A; def f; self[0]+=1; end; private; def [](i); 2; end; def []=(i,x); p x; end; end; A.new.f')
  ).toMatchObject({
    stdout: '3\n',
  });
});

test('rescue selectors see and root the active exception', () => {
  expect(run('def c; p $!.class; StandardError; end; begin; raise "bad"; rescue c; end')).toMatchObject({
    stdout: 'RuntimeError\n',
  });
  expect(
    run('class E<StandardError;def self.===(x);puts :called;true;end;end;begin;raise "bad";rescue E;puts :handled;end')
  ).toMatchObject({
    stdout: 'called\nhandled\n',
  });
});

test('implicit block conversion invokes private to_proc', () => {
  expect(run('class A; private; def to_proc; proc{|x|x+1}; end; end; p [1].map(&A.new)')).toMatchObject({
    stdout: '[2]\n',
  });
});

test('implicit super forwards changed named keywords with anonymous rest', () => {
  expect(
    run('class A; def f(a:); p a; end; end; class B<A; def f(a:,**); a=9; super; end; end; B.new.f(a:1)')
  ).toMatchObject({
    stdout: '9\n',
  });
  expect(
    run('class A; def f(a:,b:); p a,b; end; end; class B<A; def f(a:,**); a=9; super; end; end; B.new.f(a:1,b:2)')
  ).toMatchObject({
    stdout: '9\n2\n',
  });
});

test('begin modifier loops remain post-tested with rescue and ensure', () => {
  expect(run('begin; puts :body; rescue; end while false')).toMatchObject({ stdout: 'body\n' });
  expect(run('begin; puts :body; ensure; puts :ensure; end until true')).toMatchObject({
    stdout: 'body\nensure\n',
  });
});

test('modifier loop conditions resolve body locals in source order', () => {
  expect(run('a=1 until a;p a')).toMatchObject({ stdout: '1\n' });
  expect(run('a=1 while a;p a')).toMatchObject({ stdout: 'nil\n' });
});

test('Hash splat copying follows source deletions during key callbacks', () => {
  const source =
    'class K;attr_accessor :on;def hash;$h.clear if @on;0;end;end;k=K.new;$h={k=>1,a:2};k.on=true;x={**$h};p x.size,$h.size';
  expect(run(source)).toMatchObject({ stdout: '1\n0\n' });
});

test('invalid trailing Array elements and repeated rest targets fail before execution', () => {
  for (const source of ['p [a:1,2]', 'p [a:1,*[2]]', 'a,*b,*c=[1,2,3]', '[1].each{|(a,*b,*c)|p a}'])
    expect(run(source).kind).toBe('compileError');
});

test('arguments after a block argument fail before execution', () => {
  for (const source of [
    'def f(*x);p x;end;f(&proc{},1)',
    'def f(**x);p x;end;f(a:1,&proc{},b:2)',
    'def f;end;f(&proc{},&proc{})',
    'a=[1];p a[&proc{},0]',
  ])
    expect(run(source).kind).toBe('compileError');
});

test('duplicate block-local names fail before execution', () => {
  for (const source of ['[1].each{|a;a|p a}', '[1].each{|;a,a|p 1}']) expect(run(source).kind).toBe('compileError');
});

test('non-mutating module hooks can run on frozen classes', () => {
  expect(
    run('module M; def self.append_features(x); puts :append; end; end; class C; end; C.freeze; C.include(M)')
  ).toMatchObject({
    stdout: 'append\n',
  });
  expect(
    run('module M; def self.extend_object(x); puts :extend; end; end; class C; end; C.freeze; C.extend(M)')
  ).toMatchObject({
    stdout: 'extend\n',
  });
  expect(
    run(
      'module M; def self.append_features(x); puts :append; super; end; end; class C; include M; end; p C.ancestors.include?(M)'
    )
  ).toMatchObject({ stdout: 'append\ntrue\n' });
});

test('Hash pair collections identify non-array elements', () => {
  expect(
    run(
      'class P; def to_ary; nil; end; end; class A; def to_ary; [P.new]; end; end; begin; Hash[A.new]; rescue => e; p e.class,e.message; end'
    )
  ).toMatchObject({
    stdout: 'ArgumentError\n"wrong element type P at 0 (expected array)"\n',
  });
});

test('Array rotation keeps signed-long counts exact through modulus', () => {
  expect(
    run(
      'p [1,2,3].rotate(9007199254740993), [1,2,3].rotate(9223372036854775807); a=[1,2,3]; a.rotate!(-9007199254740993); p a'
    )
  ).toMatchObject({
    stdout: '[1, 2, 3]\n[2, 3, 1]\n[1, 2, 3]\n',
  });
});

test('container inspection preserves custom inspect bytes and initial encoding', () => {
  const source = `class High; def inspect; 255.chr; end; end
class Binary; def inspect; 255.chr.clear << 120; end; end
p [High.new].inspect.bytes, {a: High.new}.inspect.bytes
[[Binary.new], [1, Binary.new], {Binary.new => 1}, {a: Binary.new}].each do |value|
  text = value.inspect
  begin
    text << 256
    p :utf8
  rescue RangeError
    p :ascii
  end
end`;
  expect(run(source)).toMatchObject({
    stdout: '[91, 92, 120, 70, 70, 93]\n[123, 97, 58, 32, 92, 120, 70, 70, 125]\n:ascii\n:ascii\n:ascii\n:ascii\n',
  });
});

test('beginless Range strings keep ASCII encoding', () => {
  expect(run('s=(..2).to_s;s<<128;p s.bytes;s=(...2).to_s;s<<128;p s.bytes')).toMatchObject({
    stdout: '[46, 46, 50, 128]\n[46, 46, 46, 50, 128]\n',
  });
});

test('Symbol name is stable and frozen while conversions are mutable', () => {
  expect(
    run('p :hello.name.frozen?,:hello.name.equal?(:hello.name),:hello.to_s.frozen?,:hello.id2name.frozen?')
  ).toMatchObject({
    stdout: 'true\ntrue\nfalse\nfalse\n',
  });
  expect(run(':hello.name << "x"')).toMatchObject({ uncaughtException: expect.stringContaining('frozen') });
});

test('Array comparison limits nested comparisons through a cyclic left receiver', () => {
  const source = 'b=1;600.times{b=[b]};a=[];a<<a;p(a<=>b)';
  expect(run(source)).toMatchObject({ kind: 'limitExceeded', limit: 'output' });
});

test('exit handlers continue after an exception and expose it to earlier handlers', () => {
  expect(
    run('at_exit { puts "first"; p $!.message }; at_exit { raise "oops" }; at_exit { puts "last" }')
  ).toMatchObject({
    kind: 'executed',
    stdout: 'last\nfirst\n"oops"\n',
    uncaughtException: expect.stringContaining('oops'),
  });
  expect(run('at_exit { puts "first" }; END { raise "oops" }; END { puts "last" }')).toMatchObject({
    kind: 'executed',
    stdout: 'last\nfirst\n',
    uncaughtException: expect.stringContaining('oops'),
  });
});

test('nested parameterless blocks bind their own implicit it', () => {
  expect(run('p [[1,2],[3]].map { it.map { it + 1 } }')).toMatchObject({
    stdout: '[[2, 3], [4]]\n',
  });
  expect(run('it=9;p [1].map { it }')).toMatchObject({ stdout: '[9]\n' });
});

test('squiggly heredocs measure indentation before interpolation', () => {
  const source = 'x=5;s=<<~EOS\n  #{x}\n    b\nEOS\np s';
  expect(run(source)).toMatchObject({ stdout: '"5\\n  b\\n"\n' });
});

test('hash patterns with nil rest request every deconstructed key', () => {
  const source =
    'class X;def deconstruct_keys(keys);p keys;keys ? {a:1} : {a:1,b:2};end;end;case X.new;in {a:,**nil};puts :yes;else;puts :no;end';
  expect(run(source)).toMatchObject({ stdout: 'nil\nno\n' });
});

test('Time.at includes microseconds and normalizes negative values', () => {
  expect(run('p Time.at(0,500000).to_f,Time.at(0,-500000).to_f,Time.at(1,1.5).nsec')).toMatchObject({
    stdout: '0.5\n-0.5\n1500\n',
  });
});

test('define_method treats return in its body as a method return', () => {
  expect(
    run('class A;define_method(:value){return 42};define_method(:other,proc{return 7});end;p A.new.value,A.new.other')
  ).toMatchObject({
    stdout: '42\n7\n',
  });
});

test('public_method rejects private and protected methods', () => {
  const source =
    'class A;private;def secret;42;end;protected;def guarded;7;end;end;p A.new.method(:secret).call;[:secret,:guarded].each{|name|begin;A.new.public_method(name);rescue NameError=>e;p e.class;end}';
  expect(run(source)).toMatchObject({ stdout: '42\nNameError\nNameError\n' });
});

test('external Enumerator values retain the original yield arguments', () => {
  const source =
    'e=Enumerator.new{|y|y.yield 1,2;y.yield [3,4];y.yield};p e.peek_values,e.next_values,e.next_values,e.next_values';
  expect(run(source)).toMatchObject({ stdout: '[1, 2]\n[1, 2]\n[[3, 4]]\n[]\n' });
});

test('Time zone mutation is distinct from copying and checks frozen receivers', () => {
  const source =
    't=Time.at(0);u=t.getutc;p t.utc?,u.utc?;p t.utc.equal?(t),t.utc?;t.localtime;p t.utc?;t.freeze;begin;t.utc;rescue FrozenError=>e;p e.class;end';
  expect(run(source)).toMatchObject({ stdout: 'false\ntrue\ntrue\ntrue\nfalse\nFrozenError\n' });
});

test('Time rounds at finer than nanosecond precision', () => {
  expect(run('p Time.at(0,500000).round(10).to_f')).toMatchObject({ stdout: '0.5\n' });
});

test('Regexp rejects atomic groups whose backtracking differs', () => {
  expect(run('p /(?>a|ab)c/.match?("abc")')).toMatchObject({
    uncaughtException: expect.stringContaining('使えません。'),
  });
});

test('Regexp indices count Unicode characters and named groups retain numbering', () => {
  expect(run('p /x/.match("😀x").begin(0), /x/ =~ "😀x"')).toMatchObject({ stdout: '1\n1\n' });
  expect(run('p /(?<foo>a)(b)(?<bar>c)/.match("abc").named_captures')).toMatchObject({
    stdout: '{"foo" => "a", "bar" => "c"}\n',
  });
});

test('Regexp translation handles escaped hyphens and scoped options', () => {
  expect(run(String.raw`p "123-4567" =~ /\d{3}\-\d{4}/`)).toMatchObject({ stdout: '0\n' });
  const source = 'word=/hello/i;p "HELLO world" =~ /#{word} world/;p(/#{word} world/.source);p Regexp.union("a",/b/)';
  expect(run(source)).toMatchObject({ stdout: '0\n"(?i-mx:hello) world"\n/a|(?-mix:b)/\n' });
  expect(run('p "hello" =~ /(?i)L/')).toMatchObject({
    uncaughtException: '正規表現の中のオプションの指定（(?i) など）は、この採点環境では使えません。',
  });
});

test('literal Regexp named captures assign locals on match and clear them on miss', () => {
  const source = String.raw`year="none";if /(?<year>\d+)-/ =~ "2024-01";p year;end;p((/(?<month>\d+)/ =~ "none"),month)`;
  expect(run(source)).toMatchObject({ stdout: '"2024"\nnil\nnil\n' });
});

test('exit handler exceptions preserve every uncaught error', () => {
  expect(run('at_exit { raise "handler" }; raise "main"')).toMatchObject({
    uncaughtException: 'handler (RuntimeError)\nmain (RuntimeError)',
  });
  expect(run('at_exit { raise "h0" }; at_exit { raise "h1" }; at_exit { raise "h2" }')).toMatchObject({
    uncaughtException: 'h2 (RuntimeError)\nh1 (RuntimeError)\nh0 (RuntimeError)',
  });
});

test('method_missing receives inaccessible explicit calls', () => {
  const source =
    'class P;def method_missing(n,*a);"mm #{n}";end;private;def secret;1;end;protected;def guarded;2;end;end;p P.new.secret,P.new.guarded';
  expect(run(source)).toMatchObject({ stdout: '"mm secret"\n"mm guarded"\n' });
});

test('defined? distinguishes implicit and explicit self calls', () => {
  expect(run('def foo;1;end;p defined?(foo),defined?(self.foo),self.foo')).toMatchObject({
    stdout: '"method"\nnil\n1\n',
  });
});

test('String encoding metadata and UTF-8 validity follow its bytes', () => {
  expect(
    run(
      String.raw`p :hello.name.encoding.name,"\xFF".valid_encoding?,"\xC3\xA9".valid_encoding?,255.chr.valid_encoding?`
    )
  ).toMatchObject({
    stdout: '"US-ASCII"\nfalse\ntrue\ntrue\n',
  });
});

test('Time rejects invalid text fields and keeps historical years and copied zones', () => {
  expect(
    run(
      'begin;Time.new("abc");rescue ArgumentError=>e;p e.message;end;p Time.utc(1).year,Time.utc(99).year,Time.at(Time.utc(2024)).utc?'
    )
  ).toMatchObject({
    stdout: '"can\'t parse: \\"abc\\""\n1\n99\ntrue\n',
  });
});

test('Rational String conversion remains available and unsupported reflection remains explicit', () => {
  expect(run('p "1/2".to_r')).toMatchObject({ stdout: '(1/2)\n' });
  expect(run('1.0.rationalize')).toMatchObject({ uncaughtException: expect.stringContaining('使えません。') });
  expect(run('Object.remove_const(:X)')).toMatchObject({ uncaughtException: expect.stringContaining('使えません。') });
  expect(run('Object.public_instance_method(:to_s)')).toMatchObject({
    uncaughtException: expect.stringContaining('使えません。'),
  });
});

test('integral Rational exponents keep exact Rational results', () => {
  expect(run('p Rational(2,3)**2r,Rational(-1,3)**(-2r)')).toMatchObject({ stdout: '(4/9)\n(9/1)\n' });
});

test('Lazy Enumerable methods and external next share its source correctly', () => {
  expect(run('p [1,2,3].lazy.map{|x|x*2}.sum,[1,2,3].lazy.map{|x|x*2}.next')).toMatchObject({
    stdout: '12\n2\n',
  });
});

test('Lazy take stops after its limit even when later filters discard values', () => {
  expect(run('p [1,2,3,4].lazy.take(2).select{|x|x.odd?}.force')).toMatchObject({ stdout: '[1]\n' });
  expect(run('p [1,2,3].lazy.flat_map{|x|[x,x]}.take(2).force')).toMatchObject({ stdout: '[1, 1]\n' });
});

test('external Enumerator catch tags stay isolated from the caller', () => {
  const source =
    'e=Enumerator.new{|y|catch(:x){y<<1;y<<2}};p e.next;begin;throw :x,3;rescue UncaughtThrowError=>error;p error.class;end';
  expect(run(source)).toMatchObject({ stdout: '1\nUncaughtThrowError\n' });
});

test('external Enumerator feed and rewind preserve Ruby control flow', () => {
  const source =
    'e=Enumerator.new{|y|p y.yield(1)};e.feed(7);p e.peek_values,e.next_values;begin;e.next;rescue StopIteration;end;class C;include Enumerable;def each;yield 1;end;def rewind;$rewound=true;end;end;v=C.new.to_enum;v.next;v.rewind;p $rewound';
  expect(run(source)).toMatchObject({ stdout: '[1]\n[1]\n7\ntrue\n' });
});

test('Regexp option constants construct patterns with matching option bits', () => {
  expect(
    run(
      'p Regexp::IGNORECASE,Regexp::EXTENDED,Regexp::MULTILINE,Regexp.new("a+",Regexp::IGNORECASE).options,Regexp.new("a+",Regexp::IGNORECASE)=~"AA"'
    )
  ).toMatchObject({
    stdout: '1\n2\n4\n1\n0\n',
  });
});

test('named Structs register constants and iterate live member values', () => {
  const source =
    'S=Struct.new("Example",:a,:b);s=S.new(1,2);seen=[];s.each{|v|seen<<v;s.b=3 if v==1};p S.name,Struct::Example.equal?(S),seen';
  expect(run(source)).toMatchObject({ stdout: '"Struct::Example"\ntrue\n[1, 3]\n' });
});

test('Struct and Data to_h validate and apply transformed pairs', () => {
  expect(
    run('S=Struct.new(:a);p S.new(1).to_h{|k,v|[v,k]};D=Data.define(:a);p D.new(2).to_h{|k,v|[v,k]}')
  ).toMatchObject({
    stdout: '{1 => :a}\n{2 => :a}\n',
  });
  expect(run('Struct.new(:a).new(1).to_h{|k,v|[k]}')).toMatchObject({
    uncaughtException: expect.stringContaining('element has wrong array length'),
  });
});

test('cyclic Struct comparisons and hashes remain bounded', () => {
  expect(run('C=Struct.new(:a);s=C.new;s.a=s;t=C.new;t.a=t;p s==t;s.hash')).toMatchObject({
    kind: 'executed',
    stdout: 'true\n',
  });
  expect(run('C=Struct.new(:a);a=0;b=0;600.times{a=C.new(a);b=C.new(b)};p a==b')).toMatchObject({
    kind: 'limitExceeded',
    limit: 'output',
  });
});

test('Struct and Data keys distribute across hash buckets', () => {
  for (const constructor of ['Struct.new(:x,:y)', 'Data.define(:x,:y)']) {
    expect(run(`P=${constructor};h={};60.times{|i|60.times{|j|h[P.new(i,j)]=true}};p h.size`)).toMatchObject({
      kind: 'executed',
      stdout: '3600\n',
    });
  }
});

test('regexp replacement expansion stops at the storage limit', () => {
  expect(run(String.raw`p ("a" * 100000).sub(/a+/, "\\&" * 20)`)).toMatchObject({
    kind: 'limitExceeded',
    limit: 'storage',
  });
});

test('neutral Rational powers keep the execution budget usable', () => {
  expect(run('p Rational(1,1)**(10**400);p Rational(0,1)**(10**400)')).toMatchObject({
    kind: 'executed',
    stdout: '(1/1)\n(0/1)\n',
  });
});

test('unterminated regexp comments fail without stalling execution', () => {
  expect(run('Regexp.new("a(?#x")')).toMatchObject({
    uncaughtException: expect.stringContaining('RegexpError'),
  });
});

test('module methods bind across receiver and definition targets', () => {
  expect(
    run(
      'module M;def hello = "m";end;class C;define_method(:hey,M.instance_method(:hello));end;p M.instance_method(:hello).bind(Object.new).call,C.new.hey'
    )
  ).toMatchObject({ stdout: '"m"\n"m"\n' });
  expect(run('class A;def hello = "hi";end;class B;end;B.send(:define_method,:x,A.new.method(:hello))')).toMatchObject({
    uncaughtException: expect.stringContaining('bind argument must be a subclass of A'),
  });
});

test('singleton and alias method descriptions use their actual owners', () => {
  expect(run('class A;def self.s = 1;end;p A.method(:s),A.method(:s).unbind')).toMatchObject({
    stdout: '#<Method: A.s() main.rb:1>\n#<UnboundMethod: #<Class:A>#s() main.rb:1>\n',
  });
  expect(run('class A;def x = 1;alias y x;end;p A.new.method(:y)')).toMatchObject({
    stdout: '#<Method: A#y(x)() main.rb:1>\n',
  });
});

test('Rational rationalize preserves an exact value without tolerance', () => {
  expect(run('p Rational(1,3).rationalize')).toMatchObject({ stdout: '(1/3)\n' });
});

test('String match treats string patterns as regexp source', () => {
  expect(run('p "abc".match("a.c")[0],"abc".match?("a.c")')).toMatchObject({
    stdout: '"abc"\ntrue\n',
  });
});

test('regexp matching normalizes negative character offsets', () => {
  expect(run('p /b/.match?("ab",-1),/a/.match?("ab",-1),"ab".match?(/b/,-1)')).toMatchObject({
    stdout: 'true\nfalse\ntrue\n',
  });
});

test('regexp String helpers honor argument position, capture and freeze', () => {
  expect(run('s="abc";p s.start_with?("x",/a/),s.slice!(/(b)/,1),s')).toMatchObject({
    stdout: 'true\n"b"\n"ac"\n',
  });
  expect(run('"abc".freeze.slice!(/b/)')).toMatchObject({
    uncaughtException: expect.stringContaining('FrozenError'),
  });
});

test('inherited singleton methods bind to subclass objects', () => {
  expect(
    run(
      'class A;def self.s = 1;end;class B < A;end;B.singleton_class.send(:define_method,:t,A.method(:s).unbind);p A.method(:s).unbind.bind(B).call,B.t'
    )
  ).toMatchObject({ stdout: '1\n1\n' });
  expect(run('o=Object.new;def o.s = 2;o.method(:s).unbind.bind(Object.new)')).toMatchObject({
    uncaughtException: expect.stringContaining('singleton method called for a different object'),
  });
});

test('singleton method descriptions identify the attached object', () => {
  const result = run('o=Object.new;def o.s = 1;p o.method(:s),o.method(:s).unbind');
  expect(result).toMatchObject({ kind: 'executed' });
  if (result.kind !== 'executed') throw new Error('Ruby program did not execute');
  expect(result.stdout).toContain('#<Method: #<Object:');
  expect(result.stdout).toContain('#<UnboundMethod: #<Class:#<Object:');
});

test('Rational division methods preserve exact remainders', () => {
  expect(
    run('r=Rational(7,3);s=Rational(2,3);p r % s,r.divmod(s),r.remainder(s),r.div(s),r.fdiv(s),r.finite?,5 % s')
  ).toMatchObject({
    stdout: '(1/3)\n[3, (1/3)]\n(1/3)\n3\n3.5\ntrue\n(1/3)\n',
  });
});

test('Rational methods accept boxed Float values', () => {
  expect(run('p Rational(-0.0),Rational(1e-100) == 1e-100.to_r')).toMatchObject({
    stdout: '(0/1)\ntrue\n',
  });
});

test('Hash equality observes identity comparison for nonempty hashes', () => {
  expect(run('a={1=>2}.compare_by_identity;b={1=>2};p a==b,b==a,a.eql?(b),{}.compare_by_identity=={}')).toMatchObject({
    stdout: 'false\nfalse\nfalse\ntrue\n',
  });
  expect(
    run('s="a";t="a";h={s=>1}.compare_by_identity;g={t=>1}.compare_by_identity;p h==g,h.eql?(g),g[s],h[t]')
  ).toMatchObject({ stdout: 'true\ntrue\nnil\nnil\n' });
  expect(run('h={}.compare_by_identity;h["a"]=1;g={}.compare_by_identity;g["a"]=1;p h==g,h.eql?(g)')).toMatchObject({
    stdout: 'false\nfalse\n',
  });
  expect(
    run('a="a";b="a";h={}.compare_by_identity;h[a]=1;h[b]=2;g={}.compare_by_identity;g[a]=1;g[b]=2;p h==g,h.eql?(g)')
  ).toMatchObject({ stdout: 'true\ntrue\n' });
  expect(
    run(
      'h={}.compare_by_identity;a="a";b="a";h[a]=1;h[b]=2;g={}.compare_by_identity;c="a";d="a";g[c]=1;g[d]=2;p h==g,h.eql?(g)'
    )
  ).toMatchObject({ stdout: 'false\nfalse\n' });
});

test('one-argument respond_to? and dynamic conversion hooks work in containers', () => {
  expect(
    run(
      'class Ghost;def respond_to?(name);name.to_s.start_with?("get_")||super;end;end;p [Ghost.new].flatten.size;a,b=Ghost.new;p b'
    )
  ).toMatchObject({ stdout: '1\nnil\n' });
  expect(
    run('class Ghost;def method_missing(n,*a)="ghost #{n}";end;begin;puts Ghost.new;rescue=>e;p e.class,e.message;end')
  ).toMatchObject({ stdout: 'TypeError\n"can\'t convert Ghost to Array (Ghost#to_ary gives String)"\n' });
  expect(run('class G;def method_missing(n,*a)="ghost #{n}";end;puts [G.new,1].join(",")')).toMatchObject({
    stdout: 'ghost to_str,1\n',
  });
  expect(
    run('class G1;define_method(:respond_to?){|name|name==:to_ary ? false : super(name)};end;p [G1.new].flatten.size')
  ).toMatchObject({ stdout: '1\n' });
  expect(
    run(
      'class P;def respond_to_missing?(n,p=false)=n==:to_proc;def method_missing(n,*)=n==:to_proc ? :upcase.to_proc : super;end;p %w[a b].map(&P.new)'
    )
  ).toMatchObject({ stdout: '["A", "B"]\n' });
  expect(
    run(
      'class H;def respond_to_missing?(n,p=false)=n==:to_hash;def method_missing(n,*)=n==:to_hash ? {1=>2} : super;end;p [1,1].tally(H.new)'
    )
  ).toMatchObject({ stdout: '{1 => 4}\n' });
  expect(
    run(
      'class S;def respond_to_missing?(n,p=false)=n==:to_str;def method_missing(n,*)=n==:to_str ? "z" : super;end;p format("%c",S.new)'
    )
  ).toMatchObject({ stdout: '"z"\n' });
});

test('Hash.[] rehashes keys when dropping identity comparison', () => {
  expect(
    run('h={}.compare_by_identity;a="a";b="a";h[a]=1;h[b]=2;m=Hash[h];p m.compare_by_identity?,m[a],m[b],m.size')
  ).toMatchObject({ stdout: 'false\n2\n2\n1\n' });
});

test('Struct and Data deconstruct only requested keys', () => {
  expect(
    run(
      'S=Struct.new(:a,:b);D=Data.define(:a,:b);p S.new(1,2).deconstruct_keys([:a]),D.new(a:1,b:2).deconstruct_keys([:b])'
    )
  ).toMatchObject({
    stdout: '{a: 1}\n{b: 2}\n',
  });
});

test('generated Struct classes expose bracket construction', () => {
  expect(run('P=Struct.new(:a,:b);p P[1,2];K=Struct.new(:x,keyword_init:true);p K[x:5]')).toMatchObject({
    stdout: '#<struct P a=1, b=2>\n#<struct K x=5>\n',
  });
});

test('named Structs accept Unicode constant names', () => {
  expect(run('p Struct.new("Éclair",:x).name')).toMatchObject({ stdout: '"Struct::Éclair"\n' });
});

test('defined? checks nested arguments without invoking the call', () => {
  expect(run('p defined?(puts(no_such_name)),defined?([missing_method]),defined?({a: missing_method})')).toMatchObject({
    stdout: 'nil\nnil\nnil\n',
  });
});

test('defined? describes literals and match globals', () => {
  expect(
    run('p defined?(nil),defined?(true),defined?(false),defined?($~),defined?($1);/(a)/ =~ "a";p defined?($1)')
  ).toMatchObject({
    stdout: '"nil"\n"true"\n"false"\n"global-variable"\nnil\n"global-variable"\n',
  });
});

test('Lazy size follows source size and filtering steps', () => {
  expect(
    run('p [1,2,3].lazy.size,[1,2,3].lazy.map{_1}.size,[1,2,3].lazy.take(2).size,[1,2,3].lazy.select{true}.size')
  ).toMatchObject({
    stdout: '3\n3\n2\nnil\n',
  });
});

test('Lazy Enumerable transforms stop after the requested prefix', () => {
  expect(
    run(
      'p (1..Float::INFINITY).lazy.uniq.first(2),(1..Float::INFINITY).lazy.grep(2..4).first(2),(1..Float::INFINITY).lazy.find_all(&:odd?).first(2),(1..Float::INFINITY).lazy.collect_concat{[_1]}.first(2),(1..Float::INFINITY).lazy.zip(1..Float::INFINITY).first(2)'
    )
  ).toMatchObject({ stdout: '[1, 2]\n[2, 3]\n[1, 3]\n[1, 2]\n[[1, 1], [2, 2]]\n' });
});

test('Lazy each returns its source result and each_with_index runs with a block', () => {
  expect(
    run(
      'p [1,2].lazy.each{|x|x};p [1,2].lazy.map{|x|x}.each{|x|x};a=[];p [1,2].lazy.each_with_index{|x,i|a << [x,i]};p a'
    )
  ).toMatchObject({
    stdout: '[1, 2]\nnil\n[1, 2]\n[[1, 0], [2, 1]]\n',
  });
  expect(run('[1,2].lazy.first(-1)')).toMatchObject({
    uncaughtException: expect.stringContaining('attempt to take negative size'),
  });
  expect(run('p Enumerator.new{|y|y << 1;:done}.lazy.each{|x|x}')).toMatchObject({ stdout: ':done\n' });
});

test('Lazy flat_map streams nested values and stops at take', () => {
  expect(run('a=[];p [1].lazy.flat_map{|x|[x,x]}.map{|x|a<<x;x}.take(1).force,a')).toMatchObject({
    stdout: '[1]\n[1]\n',
  });
  expect(run('class A;def to_ary = [1,2];end;p [A.new].lazy.flat_map{|x|x}.force')).toMatchObject({
    stdout: '[1, 2]\n',
  });
  expect(run('p [1].lazy.flat_map{|x|[x,x+1].lazy}.force')).toMatchObject({ stdout: '[1, 2]\n' });
});

test('failed external enumerators restart on the next call', () => {
  expect(run('e=Enumerator.new{|y|y<<1;raise "oops"};4.times{begin;p e.next;rescue=>ex;p ex.class;end}')).toMatchObject(
    {
      stdout: '1\nRuntimeError\n1\nRuntimeError\n',
    }
  );
});

test('anonymous forwarding parameters reach implicit super', () => {
  expect(
    run('class A;def f(*a,**k,&b);p a,k,b.call;end;end;class B<A;def f(*,**,&);super;end;end;B.new.f(1,x:2){3}')
  ).toMatchObject({
    stdout: '[1]\n{x: 2}\n3\n',
  });
});

test('Time fields and fractional microseconds retain Ruby calendar values', () => {
  expect(
    run('p Time.utc(0,3,1).yday,Time.utc(99,3,1).yday,Time.at(0,0.0009).nsec,Time.at(0,-0.0005).nsec')
  ).toMatchObject({
    stdout: '61\n60\n0\n999999999\n',
  });
  expect(run('p Time.utc(2000,"Feb",3),Time.utc("2000","3","4","5","6","7")')).toMatchObject({
    stdout: '2000-02-03 00:00:00 UTC\n2000-03-04 05:06:07 UTC\n',
  });
});

test('Time localtime rejects frozen explicit offset conversions', () => {
  expect(
    run('t=Time.utc(2024).getlocal("+02:00").freeze;begin;t.localtime("+02:00");rescue=>e;p e.class;end')
  ).toMatchObject({
    stdout: 'FrozenError\n',
  });
});

test('Time strftime applies widths, flags and week directives', () => {
  expect(run('t=Time.new(2024,2,29,13,5,9);p t.strftime("%3N|%^a|%10A|%U|%W|%V|%G|%g|%r|%v|%:z|%::z")')).toMatchObject({
    stdout: '"000|THU|  Thursday|08|09|09|2024|24|01:05:09 PM|29-FEB-2024|+09:00|+09:00:00"\n',
  });
});

test('DATA rewind reads from the script and each_line advances per yield', () => {
  const rewound = 'p DATA.gets\nDATA.rewind\np DATA.gets\n__END__\na\nb\n';
  expect(run(rewound)).toMatchObject({ stdout: '"a\\n"\n"p DATA.gets\\n"\n' });
  const partial = 'DATA.each_line{|line|p line;break};p DATA.read\n__END__\na\nb\n';
  expect(run(partial)).toMatchObject({ stdout: '"a\\n"\n"b\\n"\n' });
});

test('DATA each_line returns an enumerator without consuming the cursor', () => {
  expect(run('p DATA.each_line.to_a\n__END__\na\nb\n')).toMatchObject({ stdout: '["a\\n", "b\\n"]\n' });
});

test('Integer chr preserves ASCII encoding metadata', () => {
  expect(run('p 65.chr.encoding,0.chr.encoding,255.chr.encoding')).toMatchObject({
    stdout: '#<Encoding:US-ASCII>\n#<Encoding:US-ASCII>\n#<Encoding:BINARY (ASCII-8BIT)>\n',
  });
});

test('MatchData offset accessors reject out-of-range captures', () => {
  expect(
    run('m=/a(b)/.match("ab");[:begin,:end,:offset].each{|name|begin;m.send(name,2);rescue=>e;p e.class,e.message;end}')
  ).toMatchObject({
    stdout:
      'IndexError\n"index 2 out of matches"\nIndexError\n"index 2 out of matches"\nIndexError\n"index 2 out of matches"\n',
  });
});

test('pattern matching honors deconstruction overrides and dynamic hooks', () => {
  expect(run('class A<Array;def deconstruct = [2];end;a=A.new;a<<1;p((a in [2]))')).toMatchObject({ stdout: 'true\n' });
  expect(run('class H<Hash;def deconstruct_keys(keys) = {a:2};end;h=H.new;h[:a]=1;p((h in {a:2}))')).toMatchObject({
    stdout: 'true\n',
  });
  expect(
    run('class P;def respond_to_missing?(n, *) = n==:deconstruct;def method_missing(n, *) = [1];end;p((P.new in [1]))')
  ).toMatchObject({ stdout: 'true\n' });
  expect(run('class C;def method_missing(n, *) = "x";end;p "p" + C.new')).toMatchObject({ stdout: '"px"\n' });
});

test('case in reuses a subject deconstruction across clauses', () => {
  expect(
    run(
      'class A;def initialize = @n=0;def deconstruct;@n+=1;p @n;[@n];end;end;case A.new;in [0] then p :zero;in [2] then p :two;else p :no;end'
    )
  ).toMatchObject({
    stdout: '1\n:no\n',
  });
});

test('missing-key pattern exceptions retain key and matchee', () => {
  expect(run('begin;{a:1}=>{b:};rescue NoMatchingPatternKeyError=>e;p e.key,e.matchee;end')).toMatchObject({
    stdout: ':b\n{a: 1}\n',
  });
});

test('unavailable features inside exit handlers return a program result', () => {
  expect(run('at_exit { DATA.close }; p 1\n__END__\na\n')).toMatchObject({
    stdout: '1\n',
    uncaughtException: expect.stringContaining('は、この採点環境では使えません。'),
  });
});

test('return from an exit handler reports LocalJumpError', () => {
  expect(run('at_exit { return }; p :end')).toMatchObject({
    stdout: ':end\n',
    uncaughtException: 'unexpected return',
  });
});

test('defined? does not probe block-pass expressions', () => {
  expect(run('p defined?(puts(&missing_method))')).toMatchObject({ stdout: '"method"\n' });
});

test('rebound dynamic Methods dispatch subclass method_missing', () => {
  expect(
    run(
      'class A;def respond_to_missing?(n,*)=true;def method_missing(n,*)=:a;end;class B<A;def method_missing(n,*)=:b;end;p A.new.method(:foo).unbind.bind(B.new).call'
    )
  ).toMatchObject({
    stdout: ':b\n',
  });
});

test('Time localtime validates offset before frozen state', () => {
  expect(
    run(
      't=Time.utc(2024).freeze;["bad","+24:00","+01:60",0,3600,Rational(1,2),nil].each{|offset|begin;t.localtime(offset);rescue=>e;p e.class;end}'
    )
  ).toMatchObject({
    stdout: 'ArgumentError\nArgumentError\nArgumentError\nFrozenError\nFrozenError\nFrozenError\nFrozenError\n',
  });
});

test('frozen UTC Time accepts UTC localtime no-ops', () => {
  expect(run('t=Time.utc(2024).freeze;p t.localtime("UTC").equal?(t),t.localtime("Z").equal?(t)')).toMatchObject({
    stdout: 'true\ntrue\n',
  });
  expect(run('Time.utc(2024).freeze.localtime(0)')).toMatchObject({
    uncaughtException: expect.stringContaining('FrozenError'),
  });
});

test('Time retains fractional offset values and formats rounded zones', () => {
  expect(
    run(
      'p Time.new(2024,1,1,0,0,0,Rational(1,3)).utc_offset; p Time.utc(2024).getlocal(Rational(1,10)).utc_offset; p Time.utc(2024).getlocal(1.5).strftime("%::z")'
    )
  ).toMatchObject({ stdout: '(1/3)\n(1/10)\n"+00:00:02"\n' });
  expect(
    run('t=Time.new(2024,1,1,0,0,0,Rational(1,3));p t.strftime("%F %T"),t.nsec,Time.new(2024,1,1,0,0,0,0.0001).nsec')
  ).toMatchObject({ stdout: '"2024-01-01 00:00:00"\n666666666\n999899999\n' });
  expect(run('p Time.at(0).getlocal(Rational(-1,3)),Time.at(0).getlocal(Rational(-2,5)).strftime("%z")')).toMatchObject(
    {
      stdout: '1969-12-31 23:59:59 +0000\n"+0000"\n',
    }
  );
  expect(run('p Time.at(0,0.0009)>Time.at(0),Time.at(0,0.0009)==Time.at(0),Time.at(0.3).nsec')).toMatchObject({
    stdout: 'true\nfalse\n299999999\n',
  });
  expect(
    run(
      'p Time.at(Rational(1,3000000000)).round(10)==Time.at(Rational(3,10000000000));p Time.at(Rational(1,3000000000)).strftime("%12N");p Time.at(0.3).strftime("%15N")'
    )
  ).toMatchObject({ stdout: 'true\n"000000000333"\n"299999999999999"\n' });
});

test('Rational Numeric methods and fdiv follow Ruby results', () => {
  expect(
    run(
      'r=Rational(7,3);p(+r);p r.abs2,r.magnitude,r.nonzero?,r.infinite?,r.real?,r.real,r.imaginary,Rational(1,3).fdiv(0),Rational(10**400,3).fdiv(10**399)'
    )
  ).toMatchObject({
    stdout: '(7/3)\n(49/9)\n(7/3)\n(7/3)\nnil\ntrue\n(7/3)\n0\nInfinity\n3.3333333333333335\n',
  });
});

test('large Rational operands convert to finite Floats', () => {
  expect(
    run('h=(1..1000).sum{|k|Rational(1,k)};p h.to_f,h.fdiv(1),h>7.0,Rational(10**400+1,10**400).to_f')
  ).toMatchObject({
    stdout: '7.485470860550345\n7.485470860550345\ntrue\n1.0\n',
  });
});

test('Ruby syntax validation rejects invalid numeric, parameter and regexp forms before execution', () => {
  for (const source of [
    'puts :before;p 08',
    'puts :before;p /(/',
    'puts :before;p /a(?#x/',
    'p proc{_1+it}.call(2)',
    'def f(**nil,a:1);p a;end;f',
    'puts :before;def f(a:,**nil);end;f(a:1)',
    'puts :before;def f(**nil,**nil);end;f',
  ])
    expect(run(source)).toMatchObject({ kind: 'compileError' });
});

test('regexp o option rejects explicitly before it can change interpolation behavior', () => {
  expect(run('a=1;p /#{a}/o')).toMatchObject({
    kind: 'compileError',
    diagnostics: [expect.objectContaining({ message: expect.stringContaining('は、この採点環境では使えません。') })],
  });
});

test('BEGIN hoists execution after source-order local and heredoc conversion', () => {
  expect(run('x=1;BEGIN { p x };p x')).toMatchObject({ stdout: 'nil\n1\n' });
  expect(run('s=<<A\nnormal\nA\nBEGIN { puts <<B\nbegin\nB\n}\np s')).toMatchObject({
    stdout: 'begin\n"normal\\n"\n',
  });
});

test('END blocks capture surrounding locals and accept next', () => {
  expect(run('x=3;END { p x }')).toMatchObject({ stdout: '3\n' });
  expect(run('END { next }; puts :ok')).toMatchObject({ stdout: 'ok\n' });
  expect(run('END { y=3;p y };p y')).toMatchObject({ stdout: 'nil\n3\n' });
  expect(run('def it = 42;END { p it };puts :before')).toMatchObject({ stdout: 'before\n42\n' });
  expect(run('END { p _1 };puts :before')).toMatchObject({
    stdout: 'before\n',
    uncaughtException: expect.stringContaining("undefined local variable or method '_1'"),
  });
  expect(run('END { END { y=3;p y };p y };p y')).toMatchObject({ stdout: 'nil\nnil\n3\n' });
  expect(run('f=proc{END {p it}};f.call(3)')).toMatchObject({ stdout: '3\n' });
  expect(run('f=proc{END {p _1}};f.call(3)')).toMatchObject({ stdout: '3\n' });
  expect(run('f=proc{|v|END{p it}};f.call(3)')).toMatchObject({ kind: 'compileError' });
});

test('percent literals unescape words and their delimiters', () => {
  expect(run(String.raw`p %w[a\ b c\]d],%q(a\)b)`)).toMatchObject({
    stdout: '["a b", "c]d"]\n"a)b"\n',
  });
  expect(run(String.raw`p %w[c\　d]`)).toMatchObject({ stdout: '["c\\\\　d"]\n' });
});

test('pattern validation rejects duplicate captures, alternative binds and unknown pins', () => {
  for (const source of [
    'p case [1,1];in [a,a] then a;end',
    'p case [1];in [a] | [b] then a;end',
    'p case [1];in [^missing] then 1;end',
    'p(case {a:1};in {a:}|{};a;end)',
    'puts :before;p(([1] in ([^a] => a)))',
  ])
    expect(run(source)).toMatchObject({ kind: 'compileError' });
  expect(run('a=1;p(case [1];in [^a]|[2];true;else;false;end)')).toMatchObject({ stdout: 'true\n' });
  expect(run('p(case true;in ^(([1] in [x])) | false;true;else;false;end)')).toMatchObject({ stdout: 'true\n' });
});

test('numbered block parameters reject nested, explicit and assigned misuse', () => {
  for (const source of [
    'p [[1,2]].map{_1.map{_1*2}}',
    'p [1].map{|x|_1}',
    '_1=5;p _1',
    'def _1;end',
    'p [1].map { [2].map { _1 }; _1 }',
    'p [1].map { -> { _1 }.call + _1 }',
    'def m(_1);end',
    'p ->(_1){}',
    'p [1].map { |*_1| }',
    'p [1].map { |a; _1| }',
    'p [1].map { case 1; in _1; end }',
    '/(?<_1>a)/ =~ "a"',
  ])
    expect(run(source)).toMatchObject({ kind: 'compileError' });
});

test('Regexp handles quantified properties and Ruby escaping', () => {
  expect(
    run(
      String.raw`p "日本語abc".scan(/\p{Han}+/);p "aaa" =~ /a{2}+/;p "日本日本!".scan(/\p{Han}{2}+/);p Regexp.escape("a/b#c d-e\r\f\v");p Regexp.union("a/b","c#").source`
    )
  ).toMatchObject({
    stdout: '["日本語"]\n0\n["日本日本"]\n"a/b\\\\#c\\\\ d\\\\-e\\\\r\\\\f\\\\v"\n"a/b|c\\\\#"\n',
  });
});

test('Regexp repeats complete escaped and Unicode atoms', () => {
  const emoji = String.fromCodePoint(0x1_f6_42);
  expect(run(`p "${emoji}${emoji}${emoji}"[/${emoji}{2}+/]`)).toMatchObject({ stdout: `"${emoji}${emoji}"\n` });
  expect(run(String.raw`p "AAAA"[/\x41{2}+/];p "aaaa"[/a{2}*/];p "aaaa"[/a{2}{2}/];p "AA"[/\101{2}+/]`)).toMatchObject({
    stdout: '"AAAA"\n"aaaa"\n"aaaa"\n"AA"\n',
  });
  expect(run(String.raw`p "aa"[/(a)\1/];p "1234"[/\d{2,4}?/]`)).toMatchObject({
    stdout: '"aa"\n"12"\n',
  });
});

test('Regexp bounds nested unbounded repetition', () => {
  expect(run(String.raw`p(/^(a+)+$|!/.match?("a"*30+"!"))`)).toMatchObject({
    kind: 'limitExceeded',
    limit: 'time',
  });
});

test('Regexp line boundaries and character classes follow Ruby semantics', () => {
  expect(
    run(
      String.raw`p(/a$/.match?("a\r\n"));p "\u3000" =~ /\s/;p "a\rb" =~ /a.b/;p "a\rb".scan(/^./);p(/[[:word:]]/.match?("é"))`
    )
  ).toMatchObject({ stdout: 'false\nnil\n0\n["a"]\ntrue\n' });
  expect(run(String.raw`p "ab1" =~ /\p{Alnum}+/, "x" =~ /\p{Arabic}/, " ".match?(/\p{Blank}/)`)).toMatchObject({
    stdout: '0\nnil\ntrue\n',
  });
  expect(run(String.raw`p "price: $5 + 3 = 8!".scan(/\p{Punct}/),"1+2" =~ /\p{Punct}/`)).toMatchObject({
    stdout: '[":", "!"]\nnil\n',
  });
});

test('Regexp literals freeze while constructed regexps and matches remain mutable', () => {
  expect(
    run(
      'p /a/.frozen?,Regexp.new("a").frozen?,"a".match(/a/).frozen?;r=Regexp.new("a");r.instance_variable_set(:@label,"x");p r.instance_variable_get(:@label)'
    )
  ).toMatchObject({ stdout: 'true\nfalse\nfalse\n"x"\n' });
});

test('String substitution patterns update the current match', () => {
  expect(run('p "hello".gsub("l"){$&};p "hello".sub("l"){$~[0]+"!"};"hello".sub("ell","x");p $~[0]')).toMatchObject({
    stdout: '"hello"\n"hel!lo"\n"ell"\n',
  });
});

test('method_missing super keeps the original bare-name error kind', () => {
  expect(run('class Foo;def method_missing(n,*a,&b) = super;def t = zork;end;Foo.new.t')).toMatchObject({
    uncaughtException: expect.stringContaining('(NameError)'),
  });
  expect(run('class Foo;def method_missing(n,*a,&b) = super;end;Foo.new.zork')).toMatchObject({
    uncaughtException: expect.stringContaining('(NoMethodError)'),
  });
});

test('Regexp capture names follow comments, Unicode and duplicate alternatives', () => {
  expect(run('/(a) # (?<fake>b)\n/x =~ "a";p $1')).toMatchObject({ stdout: '"a"\n' });
  const name = String.fromCodePoint(21_517, 21_069);
  expect(run(`/(?<${name}>a)/ =~ "a";p ${name};p /(?<${name}>a)/.match("a")[:${name}]`)).toMatchObject({
    stdout: '"a"\n"a"\n',
  });
  expect(run(String.raw`p /(?<x>a)|(?<x>b)/.match("a")[:x];p /(?<x>a)|(?<x>b)/.match("b")[:x]`)).toMatchObject({
    stdout: '"a"\n"b"\n',
  });
});

test('Regexp literals reject numbered backreferences beside named captures', () => {
  expect(run(String.raw`puts :before;m=/((a)|z)(?<x>b)\1/.match("aba")`)).toMatchObject({ kind: 'compileError' });
  expect(run(String.raw`p Regexp.new("((a)|z)(?<x>b)\\1").class`)).toMatchObject({
    uncaughtException: expect.stringContaining('(RegexpError)'),
  });
});

test('anonymous forwarding resolves only method parameters', () => {
  for (const source of ['q=proc{|...|p :ok};q.call', 'l=->(*,&){b(*,&)};l.call(9){}'])
    expect(run(source)).toMatchObject({ kind: 'compileError' });
  expect(run('def m(*);[1].each{p(*)};end;m(3)')).toMatchObject({ stdout: '3\n' });
});

test('Rational and Time ranges use comparison for membership', () => {
  expect(run('r=Rational(1,2)..2;p r.include?(1),r.minmax')).toMatchObject({
    stdout: 'true\n[(1/2), 2]\n',
  });
  expect(run('a=Time.utc(2000,1,1);b=Time.utc(2000,1,3);p((a..b).include?(Time.utc(2000,1,2)))')).toMatchObject({
    stdout: 'true\n',
  });
});

test('prepended modules retain their included ancestors', () => {
  expect(
    run(
      'module N;def x;"N"+super;end;end;module M;include N;def x;"M"+super;end;end;class A;include M;def x;"A";end;end;class B<A;prepend M;end;p B.ancestors.take(7),B.new.x'
    )
  ).toMatchObject({
    stdout: '[M, N, B, A, M, N, Object]\n"MNA"\n',
  });
});

test('prepended module chains merge shared descendants before super dispatch', () => {
  expect(
    run(
      'module N;def x;"N"+super;end;end;module O;def x;"O"+super;end;end;module M;include N,O;def x;"M"+super;end;end;module P;include N;def x;"P"+super;end;end;class A;include M;def x;"A";end;end;class B<A;prepend M,P;end;p B.ancestors.take(9);p B.new.x'
    )
  ).toMatchObject({ stdout: '[M, P, N, O, B, A, M, N, O]\n"MPNOA"\n' });
});

test('frozen classes reject no-op prepend and named Struct registration', () => {
  expect(run('module M;end;class A;prepend M;end;A.freeze;A.prepend(M)')).toMatchObject({
    uncaughtException: expect.stringContaining('FrozenError'),
  });
  expect(run('Struct.freeze;Struct.new("Point",:x)')).toMatchObject({
    uncaughtException: expect.stringContaining('FrozenError'),
  });
});

test('reflection errors identify the requested constant path and method class', () => {
  expect(
    run(
      'module K;A=1;end;begin;K.const_get("A::B");rescue=>e;p e.message;end;begin;1.method(:zzz);rescue=>e;p e.message;end'
    )
  ).toMatchObject({
    stdout: '"A::B does not refer to class/module"\n"undefined method \'zzz\' for class \'Integer\'"\n',
  });
});

test('regexp slice removes only a participating requested capture', () => {
  expect(run('s="ab";p s.slice!(/(a)(b)/,2),s;s="ab";p s.slice!(/(z)?ab/,1),s')).toMatchObject({
    stdout: '"b"\n"a"\n""\n"ab"\n',
  });
});

test('failed regexp prefixes clear match globals', () => {
  expect(run('/a/=~"a";p "x".start_with?("z",/z/),$~')).toMatchObject({ stdout: 'false\nnil\n' });
});

test('defined? recursively checks splatted operands', () => {
  expect(run('p defined?(puts(*missing_method)),defined?([*missing_method])')).toMatchObject({ stdout: 'nil\nnil\n' });
});

test('Lazy each_with_index rejects offset arguments', () => {
  expect(run('begin;[1,2].lazy.each_with_index(10){|x,i|p x,i};rescue=>e;p e.class,e.message;end')).toMatchObject({
    stdout: 'ArgumentError\n"wrong number of arguments (given 1, expected 0)"\n',
  });
});

test('nested pattern errors identify their failing matchee', () => {
  expect(run('begin;{a:{b:1}}=>{a:{c:}};rescue NoMatchingPatternKeyError=>e;p e.key,e.matchee;end')).toMatchObject({
    stdout: ':c\n{b: 1}\n',
  });
});

test('case-in cache applies only to the subject', () => {
  expect(
    run(
      'class A;def initialize = @n=0;def deconstruct;@n+=1;p @n;[@n];end;end;case [A.new];in [[0]];p :zero;in [[2]];p :two;else;p :no;end'
    )
  ).toMatchObject({
    stdout: '1\n2\n:two\n',
  });
});

test('nested alternatives call deconstruct for each option', () => {
  expect(
    run(
      'class A;def initialize = @n=0;def deconstruct;@n+=1;p @n;[@n];end;end;case [A.new];in [[0]|[2]];p :yes;else;p :no;end'
    )
  ).toMatchObject({
    stdout: '1\n2\n:yes\n',
  });
});

test('case-in caches missing subject deconstruction', () => {
  expect(
    run(
      'class A;def initialize = @n=0;def respond_to?(n,*);@n+=1;p @n;@n>1;end;def deconstruct = [1];end;case A.new;in [];p :empty;in [1];p :one;else;p :no;end'
    )
  ).toMatchObject({
    stdout: '1\n:no\n',
  });
});

test('missing-key matchee is the hash returned by deconstruct_keys', () => {
  expect(
    run(
      'class A;def deconstruct_keys(keys) = {};end;begin;[A.new]=>[{a:}];rescue NoMatchingPatternKeyError=>e;p e.key,e.matchee.class;end'
    )
  ).toMatchObject({
    stdout: ':a\nHash\n',
  });
});

test('Hash deconstruct_keys is callable and aliases dispatch through patterns', () => {
  expect(run('p({a:1,b:2}.deconstruct_keys([:a]))')).toMatchObject({ stdout: '{a: 1, b: 2}\n' });
  expect(
    run('class Hash;alias deconstruct_keys values_at;end;begin;p(({a:1} in {a:1}));rescue=>e;p e.class,e.message;end')
  ).toMatchObject({
    stdout: 'TypeError\n"deconstruct_keys must return Hash"\n',
  });
});

test('const_get handles absolute paths and validates empty segments first', () => {
  expect(
    run(
      'p Object.const_get("::Integer")==Integer;module K;A=1;end;begin;K.const_get("A::");rescue=>e;p e.class,e.message;end'
    )
  ).toMatchObject({
    stdout: 'true\nNameError\n"wrong constant name A::"\n',
  });
});

test('pattern matching honors Hash overrides and missing Array protocols', () => {
  expect(run('class Hash;def deconstruct_keys(keys) = {a:2};end;p(({a:1} in {a:2}))')).toMatchObject({
    stdout: 'true\n',
  });
  expect(run('class A<Array;undef deconstruct;end;p((A.new in []))')).toMatchObject({ stdout: 'false\n' });
});

test('inherited singleton Method inspect names receiver and original owner', () => {
  expect(run('class A;def self.s = 1;end;class B<A;end;p B.method(:s)')).toMatchObject({
    stdout: '#<Method: B(A).s() main.rb:1>\n',
  });
});

test('rebound dynamic Methods call method_missing on the new receiver', () => {
  expect(
    run(
      'class A;def initialize(x);@x=x;end;def respond_to_missing?(n,*)=true;def method_missing(n,*)=@x;end;a=A.new(1);b=A.new(2);p a.method(:foo).unbind.bind(b).call'
    )
  ).toMatchObject({
    stdout: '2\n',
  });
});

test('inherited Struct brackets construct the receiver class', () => {
  expect(run('Base=Struct.new(:a,:b);class Sub<Base;end;p Sub[1,2].class==Sub')).toMatchObject({
    stdout: 'true\n',
  });
});

test('Time UTC and local constructors include the seventh microsecond field', () => {
  expect(run('p Time.utc(2000,3,4,5,6,7,500000).usec,Time.local(2000,3,4,5,6,7,250000).usec')).toMatchObject({
    stdout: '500000\n250000\n',
  });
});

test('Time strftime uses directive-specific padding and case rules', () => {
  expect(
    run('t=Time.at(1709179509,123456.789).localtime("+09:30");p t.strftime("%6L|%10e|%#A|%010A|%10z|%_z|%:::z|%10:z")')
  ).toMatchObject({
    stdout: '"123456|        29|THURSDAY|00Thursday|+000000930| +930|+09:30|+000009:30"\n',
  });
});

test('anonymous rest forwards keyword hashes through implicit super', () => {
  expect(run('class B;def f(*a,**k)=[a,k];end;class D<B;def f(*)=super;end;p D.new.f(1,a:1)')).toMatchObject({
    stdout: '[[1, {a: 1}], {}]\n',
  });
});

test('Rational division rejects operands without coerce as Ruby TypeError', () => {
  expect(
    run('r=Rational(7,2);[nil,"a",Object.new].each{|v|begin;r%v;rescue=>e;p e.class,e.message;end}')
  ).toMatchObject({
    stdout:
      'TypeError\n"nil can\'t be coerced into Rational"\nTypeError\n"String can\'t be coerced into Rational"\nTypeError\n"Object can\'t be coerced into Rational"\n',
  });
});

test('Lazy take reports an Integer size for endless sources', () => {
  expect(run('p (1..).lazy.take(3).size,(1..).lazy.take(5).drop(2).size')).toMatchObject({ stdout: '3\n3\n' });
});

test('Data copies remain frozen and Rational copies preserve identity', () => {
  expect(
    run(
      'D=Data.define(:a);d=D.new(1);r=Rational(1,2);p d.dup.frozen?,d.clone(freeze:false).frozen?,r.dup.equal?(r),r.clone.equal?(r)'
    )
  ).toMatchObject({
    stdout: 'true\ntrue\ntrue\ntrue\n',
  });
});

test('Regexp bang substitutions check frozen state and match success', () => {
  expect(run('s="x";p s.sub!(/x/,"x"),s.gsub!(/z/,"y")')).toMatchObject({ stdout: '"x"\nnil\n' });
  expect(run('s="a".freeze;s.gsub!(/x/,"y")')).toMatchObject({
    uncaughtException: expect.stringContaining('FrozenError'),
  });
  expect(run('s="a";s.gsub!(/a/){s.freeze;"x"}')).toMatchObject({
    uncaughtException: expect.stringContaining('FrozenError'),
  });
});

test('Regexp substitution enforces cumulative output storage', () => {
  expect(run('("a"*1000).gsub(/a/,"x"*1100)')).toMatchObject({ kind: 'limitExceeded', limit: 'storage' });
});

test('negative Integer and Rational powers charge before large allocation', () => {
  expect(run('p 2 ** -1000000000000')).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
  expect(run('p Rational(2) ** 1000000000000')).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
  expect(run('p Rational(2) ** Rational(1,2)')).toMatchObject({ stdout: '1.4142135623730951\n' });
});

test('define_method bodies use their own method context for super', () => {
  const source = 'class A;def f(x)=x+1;end;class B<A;define_method(:f){|x|super(x)+1};end;p B.new.f(1)';
  expect(run(source)).toMatchObject({ stdout: '3\n' });
  expect(run('class A;def f(x)=x;end;class B<A;define_method(:f){|x|super};end;B.new.f(1)')).toMatchObject({
    uncaughtException: expect.stringContaining('implicit argument passing of super'),
  });
});

test('nested evaluation blocks keep their method definition target', () => {
  const source =
    'C=Class.new;C.class_eval do;1.times do;def value = 42;end;end;p C.instance_method(:value).owner;p C.new.value';
  expect(run(source)).toMatchObject({ stdout: 'C\n42\n' });
});

test('Method and UnboundMethod share reflection and validate binding', () => {
  const source =
    'class A;def hi(x)=x;define_method(:hey,instance_method(:hi));end;a=A.new;u=A.instance_method(:hi);p a.hey(3),u.arity,u.parameters,a.method(:hi).unbind.bind(a).call(4),u.bind_call(a,5);begin;u.bind(Object.new);rescue TypeError=>e;p e.class;end';
  expect(run(source)).toMatchObject({ stdout: '3\n1\n[[:req, :x]]\n4\n5\nTypeError\n' });
});

test('Method reflection keeps the alias name distinct from its original method', () => {
  expect(
    run('class A;def a = 1;alias b a;alias_method :c,:a;end;p A.new.method(:b).name;p A.instance_method(:c).name')
  ).toMatchObject({
    stdout: ':b\n:c\n',
  });
});

test('reflection honors inheritance flags and frozen state', () => {
  const source =
    'class A;X=1;def x;1;end;end;class B<A;end;p B.const_defined?(:X,false);p B.method_defined?(:x,false);p B.const_get(:X);begin;B.const_get(:X,false);rescue NameError=>e;p e.class;end';
  expect(run(source)).toMatchObject({ stdout: 'false\nfalse\n1\nNameError\n' });
  expect(run('class A;def x;1;end;end;A.freeze;A.alias_method(:y,:x)')).toMatchObject({
    uncaughtException: expect.stringContaining('FrozenError'),
  });
  expect(run('class A;end;A.freeze;A.const_set(:X,1)')).toMatchObject({
    uncaughtException: expect.stringContaining('FrozenError'),
  });
  expect(run('o=Object.new;o.instance_variable_set(:@x,1);o.freeze;o.remove_instance_variable(:@x)')).toMatchObject({
    uncaughtException: expect.stringContaining('FrozenError'),
  });
});

test('unordered constant and class-variable listings fail explicitly', () => {
  expect(run('class A;X=1;end;A.constants')).toMatchObject({
    uncaughtException: expect.stringContaining('使えません。'),
  });
  expect(run('class A;@@x=1;end;A.class_variables')).toMatchObject({
    uncaughtException: expect.stringContaining('使えません。'),
  });
});

test('prepend preserves repeated module positions for super', () => {
  const inherited =
    'module M;def x;"M"+super;end;end;class A;include M;def x;"A";end;end;class B<A;prepend M;end;p B.ancestors.take(5);p B.new.x';
  expect(run(inherited)).toMatchObject({ stdout: '[M, B, A, M, Object]\n"MA"\n' });
  const local =
    'class Object;def x;"A";end;end;module M;def x;"M"+super;end;end;class C;include M;prepend M;end;p C.ancestors.take(4);p C.new.x';
  expect(run(local)).toMatchObject({ stdout: '[M, C, M, Object]\n"MMA"\n' });
});

test('Regexp retains scoped lines, Unicode words and literal match metadata', () => {
  expect(run(String.raw`p "foo\nbar\n".gsub(/^/,"> ");p "ab\nc"[/(?m:b.c)/];p "ab\nc"[/(?-m:b.c)/m]`)).toMatchObject({
    stdout: '"> foo\\n> bar\\n"\n"b\\nc"\nnil\n',
  });
  expect(run('p(/[[:word:]]/.match?("‿"));p(/[[:word:]]/.match?("²"))')).toMatchObject({
    stdout: 'true\nfalse\n',
  });
  expect(run('"hello".sub("ell","x");p $~')).toMatchObject({ stdout: '#<MatchData: ell>\n' });
  expect(run('m=/(?<constructor>a)/.match("a");p m.names,m[:constructor],/(?<x>a)|(?<x>b)/.names')).toMatchObject({
    stdout: '["constructor"]\n"a"\n["x"]\n',
  });
});

test('Regexp rejects unsafe matching and validates runtime backreferences', () => {
  for (const source of [String.raw`p(/^(a|a)+$/.match?("a"*12+"!"))`, String.raw`p(/^(?:a*){12}$/.match?("a"*12+"!"))`])
    expect(run(source)).toMatchObject({ kind: 'executed', stdout: 'false\n' });
  expect(run(String.raw`p /(?<x>a)\101/.match("aA")[0]`)).toMatchObject({ stdout: '"aA"\n' });
  expect(run(String.raw`p Regexp.new("(?<x>a)b\\1")`)).toMatchObject({
    uncaughtException: expect.stringContaining('(RegexpError)'),
  });
  expect(
    run('r=Regexp.new(/a/);r.instance_variable_set(:@x,1);p r.frozen?,r.instance_variable_get(:@x)')
  ).toMatchObject({
    stdout: 'false\n1\n',
  });
});

test('dynamic conversion hooks and exact numeric readers match Ruby', () => {
  expect(run('class A;def method_missing(n,*);super;end;end;begin;"p"+A.new;rescue=>e;p e.class;end')).toMatchObject({
    stdout: 'TypeError\n',
  });
  expect(
    run(
      'class A;def respond_to_missing?(n,*)=[:to_ary,:to_a,:to_hash].include?(n);def method_missing(n,*)=n==:to_hash ? {a:1} : [1,2];end;p Array(A.new),Hash(A.new),[*A.new];proc{|a,b|p a,b}.call(A.new)'
    )
  ).toMatchObject({ stdout: '[1, 2]\n{a: 1}\n[1, 2]\n1\n2\n' });
  expect(run('p "1e3".to_r,".5/10".to_r,Rational("1e3")')).toMatchObject({
    stdout: '(1000/1)\n(1/20)\n(1000/1)\n',
  });
  expect(
    run('class C;def respond_to_missing?(n,*)=n==:foo;def method_missing(n,*)=1;end;c=C.new;p defined?(c.foo)')
  ).toMatchObject({
    stdout: '"method"\n',
  });
});

test('Time rejects excessive precision and accepts extended offsets', () => {
  expect(run('p Time.at(0).round(1000000000)')).toMatchObject({ kind: 'limitExceeded' });
  expect(run('p Time.at(0).strftime("%1000000000N")')).toMatchObject({ kind: 'limitExceeded' });
  expect(
    run('p Time.new(2000,1,1,0,0,0,"+09:00:01").utc_offset,Time.new(2000,1,1,0,0,0,"F").utc_offset')
  ).toMatchObject({
    stdout: '32401\n21600\n',
  });
  expect(run('Time.at("5")')).toMatchObject({
    uncaughtException: "can't convert String into an exact number (TypeError)",
  });
});

test('END uses the nearest block for implicit argument rules', () => {
  for (const source of ['p [1].map{END{p _1};[2].map{_1}}', 'p [1].map{[2].map{_1};END{p _1}}'])
    expect(run(source)).toMatchObject({ kind: 'compileError' });
  expect(run('f=proc{it;proc{END{p it}}};g=f.call(1);g.call(2)')).toMatchObject({ stdout: '2\n' });
});

test('Regexp accepts negated POSIX classes and class-local escapes', () => {
  expect(run(String.raw`p /[[:^digit:]]+/.match("a1z")[0];p /a[[:^alpha:]x]*/.match("a1z")[0]`)).toMatchObject({
    stdout: '"a"\n"a1"\n',
  });
  expect(
    run(
      String.raw`p /[\11]/.match("a\t")[0].inspect;p /[\1]/.match("a\x01")[0].inspect;p /[\8]/.match("a8")[0].inspect`
    )
  ).toMatchObject({
    stdout: '"\\"\\\\t\\""\n"\\"\\\\u0001\\""\n"\\"8\\""\n',
  });
  expect(run(String.raw`p /[^]]+/.match("ab]")[0]`)).toMatchObject({ stdout: '"ab"\n' });
  expect(run('"hello" =~ "zzz"')).toMatchObject({
    uncaughtException: 'type mismatch: String given (TypeError)',
  });
});

test('Struct and Data singleton constructors follow their super chains', () => {
  expect(run('S=Struct.new(:a);def S.new(*) = super;p S.new(1)')).toMatchObject({
    uncaughtException: 'no implicit conversion of Integer into String (TypeError)',
  });
  expect(run('D=Data.define(:x);def D.new(*) = super;p D.new(x:9)')).toMatchObject({
    uncaughtException: expect.stringContaining("super: no superclass method 'new'"),
  });
});

test('conversion failures preserve resolved method errors and dynamic fallback errors', () => {
  expect(run('class A;def to_str;nil.foo;end;end;begin;"p"+A.new;rescue=>e;p e.class;end')).toMatchObject({
    stdout: 'NoMethodError\n',
  });
  expect(
    run(
      'class E<NoMethodError;end;class A;def method_missing(n,*);raise E,"custom";end;end;begin;"p"+A.new;rescue=>e;p e.class;end'
    )
  ).toMatchObject({
    stdout: 'TypeError\n',
  });
  expect(
    run('class A;def respond_to_missing?(n,*)=n==:to_ary;def method_missing(n,*)=[1,2];end;p [0]+A.new')
  ).toMatchObject({
    stdout: '[0, 1, 2]\n',
  });
  expect(
    run('class A;def respond_to_missing?(n,*)=n==:to_str;def method_missing(n,*)="converted";end;p String(A.new)')
  ).toMatchObject({
    stdout: '"converted"\n',
  });
  expect(
    run('class A;def respond_to_missing?(n,*)=n==:to_hash;def method_missing(n,*)={a:1};end;p({}.merge(A.new))')
  ).toMatchObject({
    stdout: '{a: 1}\n',
  });
});

test('regexp matching stays fast for ordinary literal patterns', () => {
  expect(run('n=0;20000.times{n+=1 if "abc".match?(/b/)};p n')).toMatchObject({ stdout: '20000\n' });
  expect(run(String.raw`n=0;20000.times{n+=1 if "123".match?(/\d+/)};p n`)).toMatchObject({ stdout: '20000\n' });
  expect(run('p(/[[:word:]]/.match?("Ⅻ"))')).toMatchObject({ stdout: 'true\n' });
});

test('nested method_missing and lazy descriptions keep their call context', () => {
  expect(
    run(
      'class A;def method_missing(n,*a) = super;end;class B<A;def method_missing(n,*a) = super;def t = zork;end;B.new.t'
    )
  ).toMatchObject({
    uncaughtException: expect.stringContaining('(NameError)'),
  });
  expect(run('p (1..3).lazy.zip(4..6),(1..3).lazy.zip(4..6).size,(1..3).lazy.find_all(&:odd?)')).toMatchObject({
    stdout:
      '#<Enumerator::Lazy: #<Enumerator::Lazy: 1..3>:zip(4..6)>\n3\n#<Enumerator::Lazy: #<Enumerator::Lazy: 1..3>:find_all>\n',
  });
});

test('prepend merges shared descendants across direct and nested chains', () => {
  expect(
    run(
      'module N;end;module O;end;module M;include N,O;end;module P;include N;end;module Q;include O;end;class B;prepend Q,P,M;end;p B.ancestors.take(6)'
    )
  ).toMatchObject({
    stdout: '[Q, P, M, N, O, B]\n',
  });
  expect(
    run(
      'module N;end;module P;include N;end;module Q;include N;end;module M;prepend P,Q;end;class B;prepend M;end;p B.ancestors.take(5)'
    )
  ).toMatchObject({
    stdout: '[P, Q, N, M, B]\n',
  });
});

test('numbered block arguments remain exclusive across END frames', () => {
  for (const source of ['p [1].map{_1;END{[2].map{_1}}}', 'p [1].map{END{[2].map{_1}};_1}'])
    expect(run(source)).toMatchObject({ kind: 'compileError' });
});

test('extended regexp comments end after even backslash runs', () => {
  const source = String.raw`p(/(a)# ignored \\` + '\n' + String.raw`(?<real>b)/x.match("ab").to_a)`;
  expect(run(source)).toMatchObject({ stdout: '["ab", "b"]\n' });
});

test('conversion guards and literal match metadata follow Ruby lookup', () => {
  expect(run('"a".sub("a","b");begin;p $~[:constructor];rescue=>e;p e.class;end')).toMatchObject({
    stdout: 'IndexError\n',
  });
  expect(
    run('class C;def respond_to_missing?(n,priv=false)=priv;def method_missing(n,*)=:h;end;p defined?(C.new.anything)')
  ).toMatchObject({
    stdout: 'nil\n',
  });
});

test('large Rational exponents and named memberless Struct classes remain supported', () => {
  expect(run('p "1e20000".to_r.class,Struct.new("Ok").name')).toMatchObject({
    stdout: 'Rational\n"Struct::Ok"\n',
  });
  expect(run('p Struct.new("x")')).toMatchObject({ uncaughtException: expect.stringContaining('NameError') });
});

test('POSIX word classes compose with outer negation and join controls', () => {
  expect(run(String.raw`p /[^x[:^word:]]/.match?("x");p /[^[:^digit:]]/.match?("2")`)).toMatchObject({
    stdout: 'false\ntrue\n',
  });
  expect(run('p /[^[:word:]]/.match?("‌"),/[[:word:]]/.match?("‍")')).toMatchObject({
    stdout: 'false\ntrue\n',
  });
});

test('remaining Lazy methods stream or reject explicitly', () => {
  expect(
    run(
      'p (1..Float::INFINITY).lazy.each_slice(2).first(2),(1..Float::INFINITY).lazy.each_cons(2).first(2),(1..Float::INFINITY).lazy.each_with_object([]).first(2)'
    )
  ).toMatchObject({
    stdout: '[[1, 2], [3, 4]]\n[[1, 2], [2, 3]]\n[[1, []], [2, []]]\n',
  });
  expect(run('p (1..3).lazy.take(3).each_slice(2).force')).toMatchObject({ stdout: '[[1, 2], [3]]\n' });
  expect(run('p (1..Float::INFINITY).lazy.slice_when{true}.first(2)')).toMatchObject({
    uncaughtException: expect.stringContaining('は、この採点環境では使えません。'),
  });
});

test('new Ruby class methods run or fail with the unavailable contract', () => {
  expect(
    run(
      String.raw`p Struct.new(:a,:b).new(1,2).values_at(0..3);m=/(?<year>\d+)/.match("2024");p m.deconstruct_keys([:year])`
    )
  ).toMatchObject({
    stdout: '[1, 2, nil, nil]\n{year: "2024"}\n',
  });
  for (const source of ['Time.utc(2024).iso8601', '/a/.named_captures', '1.method(:+).curry', 'Time.now(in: "UTC")'])
    expect(run(source)).toMatchObject({
      uncaughtException: expect.stringContaining('は、この採点環境では使えません。'),
    });
});

test('source CRLF normalizes regexp comment continuation', () => {
  const source = `p(/(a)# ignored ${String.fromCodePoint(92)}\r\n(?<real>b)/x.match("ab").to_a)`;
  expect(run(source)).toMatchObject({ stdout: '["a", "a"]\n' });
});

test('regexp slash display, union and equal MatchData hashes match Ruby', () => {
  const source = String.raw`r=/a\/b/
p r.source, r.to_s, %r{a\/b}.source
p Regexp.union(r).equal?(r)
a=/(a)/.match("a"); p a.hash == /(a)/.match("a").hash
"a" =~ /a/; nil =~ /a/; p $~
`;
  expect(run(source)).toMatchObject({
    stdout: String.raw`"a/b"
"(?-mix:a\\/b)"
"a\\/b"
true
true
#<MatchData "a">
`,
  });
});

test('short regexp matches avoid the expensive watchdog path', () => {
  expect(run(String.raw`60000.times { "123".match?(/\A\d{1,3}\z/) }; p :ok`)).toMatchObject({
    kind: 'executed',
    stdout: ':ok\n',
  });
});

test('method hooks fail explicitly only when they act as hooks', () => {
  expect(run('class A; def self.method_removed(n); end; end')).toMatchObject({
    uncaughtException: 'メソッド・定数フック（method_removed）は、この採点環境では使えません。',
  });
  expect(run('class A; def method_added(n); 1; end; end; p :ok')).toMatchObject({ stdout: ':ok\n' });
});

test('squiggly heredocs strip indentation at tab stops', () => {
  expect(run('p <<~EOS\n\tfoo\n  bar\nEOS')).toMatchObject({ stdout: '"\\tfoo\\nbar\\n"\n' });
});

test('Enumerator.produce stops on StopIteration subclasses', () => {
  expect(
    run(
      'p Enumerator.produce { raise StopIteration }.to_a; class Done < StopIteration; end; p Enumerator.produce(1) { raise Done }.to_a'
    )
  ).toMatchObject({
    stdout: '[]\n[1]\n',
  });
});

test('class variable and constant reflection traverse ancestry', () => {
  expect(
    run(
      'class A; @@n=1; end; class B<A; end; B.class_variable_set(:@@n,2); p A.class_variable_get(:@@n), B.class_variable_get(:@@n); module M; module N; X=1; end; end; p Object.const_defined?("M::N::X")'
    )
  ).toMatchObject({
    stdout: '2\n2\ntrue\n',
  });
});

test('negative Time rounding precision raises before exponentiation', () => {
  expect(run('Time.at(5).round(-10000000000)')).toMatchObject({
    uncaughtException: 'negative ndigits given (ArgumentError)',
  });
});

test('Time displays offset seconds outside strftime minute directives', () => {
  expect(run('p Time.new(2024,1,1,0,0,0,"+05:30:45"), Time.at(0).getlocal(45)')).toMatchObject({
    stdout: '2024-01-01 00:00:00 +053045\n1970-01-01 00:00:45 +000045\n',
  });
});

test('Regexp case comparison treats nil to_str as a miss', () => {
  expect(run('o=Object.new; def o.to_str; nil; end; p(/a/ === o)')).toMatchObject({ stdout: 'false\n' });
});

test('scan and literal substitution restore their final match after callbacks', () => {
  expect(run('"aba".scan(/a/) { /b/ =~ "b" }; p $&; "aba".gsub("a") { /b/ =~ "b"; "x" }; p $&')).toMatchObject({
    stdout: '"a"\n"a"\n',
  });
});

test('MatchData values_at expands range selectors', () => {
  expect(run('p /(a)(b)(c)/.match("abc").values_at(0,1..2)')).toMatchObject({
    stdout: '["abc", "a", "b"]\n',
  });
});

test('regexp callbacks reject source mutation', () => {
  expect(run('s="aba"; begin; s.gsub(/a/) { s << "x"; "z" }; rescue => e; p e.class,e.message;end')).toMatchObject({
    stdout: 'RuntimeError\n"string modified"\n',
  });
});

test('regexp partitions find first and rightmost overlapping matches', () => {
  expect(run('p "ababa".partition(/aba/), "ababa".rpartition(/aba/)')).toMatchObject({
    stdout: '["", "aba", "ba"]\n["ab", "aba", ""]\n',
  });
});

test('DATA starts after the complete CRLF marker line', () => {
  expect(run('p DATA.read\r\n__END__\r\na\r\n')).toMatchObject({ stdout: '"a\\r\\n"\n' });
});

test('Lazy forwards iteration arguments to learner enumerables', () => {
  expect(
    run(
      'class C; include Enumerable; def each(n=1); n.times { |x| yield x }; end; end; p C.new.lazy.force(3), C.new.lazy.each(3).force'
    )
  ).toMatchObject({
    stdout: '[0, 1, 2]\n[0, 1, 2]\n',
  });
});

test('reflection names accept to_str and qualified paths limit Object fallback', () => {
  expect(
    run(
      'o=Object.new; def o.to_str; "upcase";end; p "abc".send(o), "abc".respond_to?(o); class A;end; p Object.const_defined?("A::String")'
    )
  ).toMatchObject({
    stdout: '"ABC"\ntrue\nfalse\n',
  });
});

test('active inherited definition hooks fail explicitly', () => {
  expect(run('module Hook; def method_added(n); p n;end;end;class A;extend Hook;def x;end;end')).toMatchObject({
    uncaughtException: 'メソッド・定数フック（method_added）は、この採点環境では使えません。',
  });
});

test('pattern failures avoid inspect until an error needs it', () => {
  expect(
    run('class A; def inspect; puts "inspected"; "A";end;end; case A.new; in Integer; p :int; else; p :other; end')
  ).toMatchObject({
    stdout: ':other\n',
  });
});

test('empty hash patterns request every deconstructed key', () => {
  expect(run('class A; def deconstruct_keys(k); k ? {x:1}.slice(*k) : {x:1};end;end; p((A.new in {}))')).toMatchObject({
    stdout: 'false\n',
  });
});

test('interpolated regexp text retains its own escapes', () => {
  expect(run(String.raw`s="a\\/b"; p /#{s}/.source, /#{s}/ == Regexp.new(s)`)).toMatchObject({
    stdout: '"a\\\\/b"\ntrue\n',
  });
});

test('sleep validates NaN before updating virtual time', () => {
  expect(run('begin; sleep(Float::NAN); rescue => e; p e.class,e.message;end')).toMatchObject({
    stdout: 'RangeError\n"NaN out of Time range"\n',
  });
});

test('duplicate regexp capture names fail with an unavailable-feature message', () => {
  expect(run('p /(?<a>x)(?<a>y)/.match("xy")[:a]')).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ message: '重複する名前付きキャプチャは、この採点環境では使えません。' }],
  });
});

test('defined? checks protected method visibility', () => {
  expect(
    run('class A; protected def x;end; public def f(o); p defined?(o.x);end;end; p defined?(A.new.x); A.new.f(A.new)')
  ).toMatchObject({
    stdout: 'nil\n"method"\n',
  });
});

test('prepend invokes overridable feature and notification hooks', () => {
  expect(
    run(
      'module M; def self.prepend_features(base); puts :features; super;end; def self.prepended(base); puts :prepended;end;end; class A; prepend M; prepend M;end'
    )
  ).toMatchObject({
    stdout: 'features\nprepended\nfeatures\nprepended\n',
  });
});

test('indefinite sleep stops before later statements', () => {
  expect(run('p sleep; p :after')).toMatchObject({ kind: 'limitExceeded', limit: 'time' });
  expect(run('p sleep(nil); p :after')).toMatchObject({ kind: 'limitExceeded', limit: 'time' });
});

test('non-lambda Proc arity ignores optional parameters', () => {
  expect(run('p proc { |a,b=1| }.arity, proc { |a=0| }.arity, lambda { |a,b=1| }.arity')).toMatchObject({
    stdout: '1\n0\n-2\n',
  });
});

test('regexp callbacks permit same-length source edits and continue from current text', () => {
  expect(run('s="abc"; p s.gsub(/a/) { s[1]="X"; "z" }; s="aba"; p s.gsub(/a/) { s[2]="b"; "x" }')).toMatchObject({
    stdout: '"zXc"\n"xbb"\n',
  });
});

test('rpartition searches from the right on long strings', () => {
  expect(run('p ("a" * 50000).rpartition(/a/).map(&:length)')).toMatchObject({
    kind: 'executed',
    stdout: '[49999, 1, 0]\n',
  });
});

test('strftime formats negative calendar and ISO years', () => {
  expect(run('p Time.utc(-1).strftime("%Y %y %C %G %g")')).toMatchObject({
    stdout: '"-0001 99 -1 -0002 98"\n',
  });
});

test('Rational equality delegates to custom objects', () => {
  expect(run('class N; def ==(x); p x; true; end;end; p Rational(1,2)==N.new')).toMatchObject({
    stdout: '(1/2)\ntrue\n',
  });
});

test('POSIX and Word regexp classes follow Unicode properties', () => {
  const program = String.raw`p "　".match?(/[[:space:]]/), " ".match?(/[[:blank:]]/), "٣".match?(/[[:digit:]]/), "Ⅻ".match?(/[[:alnum:]]/), "́".match?(/[[:alpha:]]/), "+".match?(/[[:punct:]]/), "1_".scan(/\p{Word}/)`;
  expect(run(program)).toMatchObject({ stdout: 'true\ntrue\ntrue\ntrue\nfalse\ntrue\n["1", "_"]\n' });
});

test('public_method_defined? excludes protected methods', () => {
  expect(
    run(
      'class A; protected def f;end;end;p A.method_defined?(:f),A.public_method_defined?(:f),A.protected_method_defined?(:f)'
    )
  ).toMatchObject({
    stdout: 'true\nfalse\ntrue\n',
  });
});

test('String.new accepts supported options and defaults to binary encoding', () => {
  expect(
    run(
      'p String.new.encoding, String.new(capacity:10).encoding, String.new(encoding:"UTF-8").encoding, String.new("abc",capacity:5)'
    )
  ).toMatchObject({
    stdout: '#<Encoding:BINARY (ASCII-8BIT)>\n#<Encoding:BINARY (ASCII-8BIT)>\n#<Encoding:UTF-8>\n"abc"\n',
  });
});

test('MatchData holds one frozen source snapshot', () => {
  expect(run('m=/a/.match("abc");p m.string.frozen?,m.string.equal?(m.string)')).toMatchObject({
    stdout: 'true\ntrue\n',
  });
});

test('Time strftime echoes unknown directives and getlocal retains UTC identity', () => {
  expect(
    run('p Time.new(2024).strftime("%Q %q %J %K"); t=Time.at(0).getlocal("UTC"); p t.utc?,t.zone,t')
  ).toMatchObject({
    stdout: '"%Q %q %J %K"\ntrue\n"UTC"\n1970-01-01 00:00:00 UTC\n',
  });
});

test('regexp split clears an unrelated prior match', () => {
  expect(run('/a/=~"a";"abc".split(/b/);p $&')).toMatchObject({ stdout: 'nil\n' });
});

test('Rational text accepts decimal denominators', () => {
  expect(run('p Rational("1/2.5"), "1/2.5".to_r')).toMatchObject({ stdout: '(2/5)\n(2/5)\n' });
});

test('Lazy preserves source yield argument lists', () => {
  expect(
    run(
      'e=Enumerator.new{|y|y.yield 1,2};p e.lazy.map{|*args|args}.force; Enumerator.new{|y|y.yield}.lazy.each{|*args|p args}'
    )
  ).toMatchObject({
    stdout: '[[1, 2]]\n[]\n',
  });
  expect(
    run(
      'e=Enumerator.new{|y|y.yield};p e.lazy.force,e.lazy.map{|*a|a}.force,e.lazy.take(1).force,e.lazy.each_entry.force,e.lazy.compact.force'
    )
  ).toMatchObject({ stdout: '[nil]\n[[nil]]\n[nil]\n[nil]\n[]\n' });
  expect(
    run(
      'e=Enumerator.new{|y|y.yield 1,2};p e.lazy.uniq.map{|*a|a}.force,e.lazy.grep(Array).map{|*a|a}.force,e.lazy.with_index.map{|*a|a}.force,e.lazy.each_with_object(nil).map{|*a|a}.force'
    )
  ).toMatchObject({ stdout: '[[1, 2]]\n[[1, 2]]\n[[[1, 2], 0]]\n[[[1, 2], nil]]\n' });
  expect(run('e=Enumerator.new{|y|y.yield 1,2};p e.lazy.with_index{|v,i|nil}.map{|*a|a}.force')).toMatchObject({
    stdout: '[[[1, 2]]]\n',
  });
  expect(
    run(
      'class A;def respond_to_missing?(n,*)=n==:to_ary;def method_missing(n,*)=[1,2];end;p [0].lazy.flat_map{A.new}.map{|x|x.class}.force'
    )
  ).toMatchObject({ stdout: '[Integer, Integer]\n' });
  expect(
    run('class A;def to_ary;1;end;end;begin;[0].lazy.flat_map{A.new}.force;rescue=>e;p e.class,e.message;end')
  ).toMatchObject({ stdout: 'TypeError\n"can\'t convert A to Array (A#to_ary gives Integer)"\n' });
  expect(run('begin;(1..3).lazy.collect.to_a;rescue=>e;p e.class,e.message;end')).toMatchObject({
    stdout: 'ArgumentError\n"tried to call lazy map without a block"\n',
  });
});

test('regexp replacement expands the last participating capture', () => {
  expect(run(String.raw`p "abc".sub(/(a)(b)?/, "\\+"), "a".sub(/(a)(b)?/, "\\+")`)).toMatchObject({
    stdout: '"bc"\n"a"\n',
  });
});

test('regexp replacement resolves Unicode named captures', () => {
  expect(run(String.raw`p "ab".sub(/(?<名前>a)/, "\\k<名前>"),"ab".sub(/(?<όνομα>a)/, "\\k<όνομα>")`)).toMatchObject({
    stdout: '"ab"\n"ab"\n',
  });
});

test('finite fractional sleeps remain within the virtual clock', () => {
  expect(run('p sleep(0.0005), sleep(Rational(1,3))')).toMatchObject({ stdout: '0\n0\n' });
});

test('Range minmax uses endpoints without iterating custom values', () => {
  expect(
    run(
      'class T;include Comparable;attr_reader :n;def initialize(n);@n=n;end;def <=>(o);n<=>o.n;end;end;p (T.new(1)..T.new(3)).minmax.map(&:n), ("b"..."d").minmax'
    )
  ).toMatchObject({
    stdout: '[1, 3]\n["b", "c"]\n',
  });
});

test('Rational arithmetic charges large native allocations', () => {
  expect(run('r=2r;22.times{r=r*r};p r.numerator.bit_length')).toMatchObject({
    kind: 'limitExceeded',
    limit: 'operations',
  });
});

test('DATA class cannot construct an unsupported File', () => {
  expect(run('DATA.class.new.read\n__END__\na\n')).toMatchObject({
    uncaughtException: 'File オブジェクトの生成は、この採点環境では使えません。',
  });
});

test('class-variable reflection validates names', () => {
  expect(run('class A;end;A.class_variable_set(:count,1)')).toMatchObject({
    uncaughtException: "'count' is not allowed as a class variable name (NameError)",
  });
});

test('strftime year flags override default padding', () => {
  expect(run('p Time.utc(42).strftime("%-Y %_Y %G"), Time.utc(-1).strftime("%-Y %_Y %0Y")')).toMatchObject({
    stdout: '"42   42 0042"\n"-1    -1 -0001"\n',
  });
});

test('untranslatable regexp names and backreferences fail explicitly', () => {
  expect(run(String.raw`p /(?<n-1>\w)/.names`)).toMatchObject({
    uncaughtException: '正規表現の特殊なキャプチャ名は、この採点環境では使えません。',
  });
  expect(run(String.raw`p "b".match?(/(a)?b\1/)`)).toMatchObject({
    uncaughtException: '正規表現の省略可能なキャプチャへの後方参照は、この採点環境では使えません。',
  });
});

test('variable-length lookbehind is a compile error', () => {
  expect(run(String.raw`puts :before; p /(?<=a+)b/.match?("aab")`)).toMatchObject({ kind: 'compileError' });
});

test('unrepresentable multi-character case folds fail explicitly', () => {
  expect(run(String.raw`p "ß".match?(/ss/i)`)).toMatchObject({
    uncaughtException: 'Unicode の複数文字 casefold は、この採点環境では使えません。',
  });
});

test('underscore pattern targets receive matched values', () => {
  expect(run('1 => _; p _; [1,2] => [_,_]; p _')).toMatchObject({ stdout: '1\n2\n' });
});

test('CRLF heredocs normalize source line endings', () => {
  expect(run('s=<<~EOS\r\n  a\r\nEOS\r\np s')).toMatchObject({ stdout: '"a\\n"\n' });
});

test('compound equality dispatches native value eql?', () => {
  expect(
    run('S=Struct.new(:x);a=S.new(1r);b=S.new(1r);p a.eql?(b),{a=>:hit}[b],[Time.at(0)].eql?([Time.at(0)])')
  ).toMatchObject({
    stdout: 'true\n:hit\ntrue\n',
  });
});

test('Data reports missing keywords before unknown ones', () => {
  expect(run('Coord=Data.define(:lat,:lng);Coord.new(lat:1,lon:2)')).toMatchObject({
    uncaughtException: 'missing keyword: :lng (ArgumentError)',
  });
});

test('Struct and Data allocate nil-filled member storage', () => {
  expect(run('S=Struct.new(:x);D=Data.define(:x);p S.allocate,D.allocate')).toMatchObject({
    stdout: '#<struct S x=nil>\n#<data D x=nil>\n',
  });
  expect(run('S=Struct.new(:x);def S.allocate;puts :custom;super;end;p S.new(1)')).toMatchObject({
    stdout: '#<struct S x=1>\n',
  });
  expect(run('D=Data.define(:x);def D.allocate;puts :custom;super;end;p D.new(1)')).toMatchObject({
    stdout: '#<data D x=1>\n',
  });
});

test('copied Struct and Data classes retain their member layouts', () => {
  expect(run('S=Struct.new(:x);p S.dup.new(1);D=Data.define(:x);p D.dup.new(1)')).toMatchObject({
    stdout: '#<struct x=1>\n#<data x=1>\n',
  });
});

test('Data subclasses do not inherit the define factory', () => {
  expect(run('D=Data.define(:a);p D.respond_to?(:define);begin;D.define(:x);rescue=>e;p e.class;end')).toMatchObject({
    stdout: 'false\nNoMethodError\n',
  });
});

test('Struct and Data initializers enforce their freeze lifecycle', () => {
  expect(
    run('S=Struct.new(:x);s=S.new(1).freeze;begin;s.send(:initialize,2);rescue=>e;p e.class;end;p s')
  ).toMatchObject({
    stdout: 'FrozenError\n#<struct S x=1>\n',
  });
  expect(run('D=Data.define(:x);d=D.new(1);begin;d.send(:initialize,x:2);rescue=>e;p e.class;end;p d')).toMatchObject({
    stdout: 'FrozenError\n#<data D x=1>\n',
  });
  expect(run('D=Data.define(:x){def initialize(x:);@y=x;end};p D.new(x:1).frozen?')).toMatchObject({
    stdout: 'false\n',
  });
});

test('Struct dig returns nil for missing names and indexes', () => {
  expect(run('S=Struct.new(:a);p S.new(1).dig(:b),S.new(1).dig(2)')).toMatchObject({ stdout: 'nil\nnil\n' });
  expect(run('S=Struct.new(:x);begin;S.new(1).dig(:x,:y);rescue=>e;p e.class,e.message;end')).toMatchObject({
    stdout: 'TypeError\n"Integer does not have #dig method"\n',
  });
});

test('String.new retains UTF-8 bytes when choosing binary encoding', () => {
  expect(run('s=String.new("é",encoding:"ASCII-8BIT");p s.bytes,s.bytesize')).toMatchObject({
    stdout: '[195, 169]\n2\n',
  });
  expect(run('p 65.chr.encoding,String.new(65.chr).encoding')).toMatchObject({
    stdout: '#<Encoding:US-ASCII>\n#<Encoding:US-ASCII>\n',
  });
  expect(run('s=String.new("é",encoding:Encoding::US_ASCII);p s.valid_encoding?,s.bytes')).toMatchObject({
    stdout: 'false\n[195, 169]\n',
  });
  expect(run('p String.new("a",encoding:"utf-8").encoding,String.new("a",encoding:"binary").encoding')).toMatchObject({
    stdout: '#<Encoding:UTF-8>\n#<Encoding:BINARY (ASCII-8BIT)>\n',
  });
});

test('END registers each syntax site once', () => {
  expect(run('3.times { |i| END { puts "END #{i}" } }')).toMatchObject({ stdout: 'END 0\n' });
});

test('Enumerator.new normalizes numeric size and calls size Procs', () => {
  expect(run('p Enumerator.new(-> {3}){|y|y<<1}.size, Enumerator.new(2.5){|y|}.size')).toMatchObject({
    stdout: '3\n2\n',
  });
  expect(
    run('[Float::NAN,-Float::INFINITY].each{|s|begin;Enumerator.new(s){};rescue=>e;p e.class,e.message;end}')
  ).toMatchObject({ stdout: 'FloatDomainError\n"NaN"\nFloatDomainError\n"-Infinity"\n' });
});

test('direct Enumerator helpers initialize their blocks and guard allocate', () => {
  expect(run('Enumerator::Yielder.new{|v|p v}.yield(1);Enumerator::Generator.new{|y|y<<2}.each{|x|p x}')).toMatchObject(
    {
      stdout: '1\n2\n',
    }
  );
  expect(
    run(
      'begin;Enumerator::Yielder.allocate.yield(1);rescue=>e;p e.class,e.message;end;begin;Enumerator::Generator.allocate.each{|x|};rescue=>e;p e.class,e.message;end'
    )
  ).toMatchObject({ stdout: 'ArgumentError\n"uninitialized yielder"\nArgumentError\n"uninitialized generator"\n' });
});

test('copied Enumerators start independently and reject active cursor copies', () => {
  expect(run('e=(1..3).each;f=e.dup;p e.next,f.next')).toMatchObject({ stdout: '1\n1\n' });
  expect(run('e=(1..3).each;e.next;begin;e.dup;rescue=>x;p x.class,x.message;end')).toMatchObject({
    stdout: 'TypeError\n"can\'t copy execution context"\n',
  });
});

test('Lazy zip converts array-like arguments before iteration', () => {
  expect(run('class A;def to_ary;[3,4];end;end;p [1,2].lazy.zip(A.new).force')).toMatchObject({
    stdout: '[[1, 3], [2, 4]]\n',
  });
});

test('Lazy counts reject oversized integers and keep infinite grouped sizes', () => {
  expect(run('p [1].lazy.take(10**400).size')).toMatchObject({
    uncaughtException: expect.stringContaining('bignum too big to convert into'),
  });
  expect(run('p (1..).lazy.each_slice(2).size,(1..).lazy.each_cons(2).size')).toMatchObject({
    stdout: 'Infinity\nInfinity\n',
  });
});

test('uninitialized Enumerator raises a Ruby error', () => {
  expect(run('begin;Enumerator.allocate.next;rescue=>e;p e.class,e.message;end')).toMatchObject({
    stdout: 'ArgumentError\n"uninitialized enumerator"\n',
  });
});

test('public_send rejects protected methods from their owner', () => {
  expect(
    run(
      'class C;protected;def x;1;end;public;def y;public_send(:x);end;end;begin;C.new.y;rescue=>e;p e.class,e.message;end'
    )
  ).toMatchObject({ stdout: 'NoMethodError\n"protected method \'x\' called for an instance of C"\n' });
});

test('define_method preserves missing-call reasons through super', () => {
  expect(
    run(
      'class A;define_method(:method_missing){|n,*a|super(n,*a)};def foo;zzz;end;end;begin;A.new.foo;rescue=>e;p e.class,e.message;end'
    )
  ).toMatchObject({ stdout: 'NameError\n"undefined local variable or method \'zzz\' for an instance of A"\n' });
});

test('allocated Regexp and Time reject native operations as Ruby errors', () => {
  expect(
    run(
      'begin;Regexp.allocate.match("a");rescue=>e;p e.class,e.message;end;begin;Time.allocate.year;rescue=>e;p e.class,e.message;end'
    )
  ).toMatchObject({ stdout: 'TypeError\n"uninitialized Regexp"\nTypeError\n"uninitialized Time"\n' });
});

test('Method and MatchData reject public construction', () => {
  expect(
    run(
      'begin;Method.new;rescue=>e;p e.class;end;begin;Method.allocate;rescue=>e;p e.class;end;begin;MatchData.new;rescue=>e;p e.class;end'
    )
  ).toMatchObject({ stdout: 'NoMethodError\nTypeError\nNoMethodError\n' });
});

test('unsupported Proc composition and Hash subset operators fail explicitly', () => {
  expect(run('proc{|x|x} >> proc{|x|x}')).toMatchObject({
    uncaughtException: expect.stringContaining('Proc#>> は、この採点環境では使えません。'),
  });
  expect(run('{a:1} <= {a:1,b:2}')).toMatchObject({
    uncaughtException: expect.stringContaining('Hash#<= は、この採点環境では使えません。'),
  });
});

test('regexp replacement Hash uses its default callback', () => {
  expect(run('h=Hash.new{|_,k|k.upcase};p "abc".gsub(/./,h)')).toMatchObject({ stdout: '"ABC"\n' });
  expect(run('h=Hash.new{|_,k|p $&;k.upcase};p "abc".gsub(/./,h)')).toMatchObject({
    stdout: '"a"\n"b"\n"c"\n"ABC"\n',
  });
});

test('regexp substitution converts string-like replacements once before matching', () => {
  expect(run('class R;def initialize;@n=0;end;def to_str;@n+=1;@n.to_s;end;end;p "ab".gsub(/./,R.new)')).toMatchObject({
    stdout: '"11"\n',
  });
  expect(run('p "ab".gsub(/z/,1)')).toMatchObject({
    uncaughtException: 'no implicit conversion of Integer into String (TypeError)',
  });
});

test('define_method gives break method-body control flow', () => {
  expect(run('class A; define_method(:f) { break 3 }; end; p A.new.f')).toMatchObject({ stdout: '3\n' });
});

test('unambiguous repeated regexp groups remain supported', () => {
  expect(run(String.raw`p "catdog" =~ /\A(cat|dog)+\z/, "a@b.co.jp".match?(/\A\w+@\w+(\.\w+)+\z/)`)).toMatchObject({
    stdout: '0\ntrue\n',
  });
});

test('renamed Method bodies retain their source super name', () => {
  expect(
    run(
      'class Base;def f;"B";end;end;class A<Base;def f;"A"+super;end;end;class C<A;define_method(:g,A.instance_method(:f));end;p C.new.g'
    )
  ).toMatchObject({
    stdout: '"AAB"\n',
  });
  expect(
    run(
      'class Base;def f;"B";end;end;class A<Base;def f;[defined?(super),super];end;end;class C<A;define_method(:g,A.instance_method(:f));end;p C.new.g'
    )
  ).toMatchObject({ stdout: '["super", ["super", "B"]]\n' });
});

test('Method and UnboundMethod wrappers compare by binding and body', () => {
  expect(
    run(
      'class A;def f;1;end;alias g f;end;a=A.new;p a.method(:f)==a.method(:g),A.instance_method(:f)==A.instance_method(:f),{a.method(:f)=>:hit}[a.method(:f)]'
    )
  ).toMatchObject({
    stdout: 'true\ntrue\n:hit\n',
  });
  expect(run('s="a";p s.method(:size)==s.method(:length),{s.method(:size)=>:hit}[s.method(:length)]')).toMatchObject({
    stdout: 'true\n:hit\n',
  });
  expect(
    run(
      's="abc";p s.method(:slice)==s.method(:[]),{s.method(:slice)=>:hit}[s.method(:[])],String.instance_method(:slice)==String.instance_method(:[])'
    )
  ).toMatchObject({ stdout: 'true\n:hit\ntrue\n' });
});

test('inherited definition hooks also block removal silently skipping callbacks', () => {
  expect(
    run('module Hook;def method_removed(n);puts n;end;end;class A;extend Hook;def x;end;remove_method :x;end')
  ).toMatchObject({
    uncaughtException: 'メソッド・定数フック（method_removed）は、この採点環境では使えません。',
  });
  expect(run('module H;def method_removed(n);end;end;class A;extend H;end;p A.remove_method(*[])==A')).toMatchObject({
    stdout: 'true\n',
  });
});

test('exclusive Range max follows successor iteration for Symbols', () => {
  expect(
    run('p (:a...:d).max; begin; (Time.utc(2024)...Time.utc(2025)).max; rescue => e; p e.message; end')
  ).toMatchObject({
    stdout: ':c\n"can\'t iterate from Time"\n',
  });
  expect(
    run(
      '[[2.0,1],[1.0,1],[1.0,2],[Rational(1),Rational(3)]].each{|a|begin;p (a[0]...a[1]).max;rescue=>e;p e.message;end}'
    )
  ).toMatchObject({
    stdout:
      'nil\nnil\n"cannot exclude end value with non Integer begin value"\n"cannot exclude non Integer end value"\n',
  });
  expect(run('begin;(1.0...1.0).max;rescue=>e;p e.class,e.message;end')).toMatchObject({
    stdout: 'TypeError\n"cannot exclude non Integer end value"\n',
  });
});

test('regexp rindex clamps offsets beyond the string end', () => {
  expect(run('p "abc".rindex(/a/,100),"abc".index(/a/,100)')).toMatchObject({ stdout: '0\nnil\n' });
});

test('non-leading unparenthesized command arguments fail before execution', () => {
  for (const source of ['x=[1,2]; p x, x.join ","', 'def f1;1;end;def f2(a);a;end;p f1, f2 2'])
    expect(run(source)).toMatchObject({ kind: 'compileError' });
  expect(run('x=[1,2]; p x, x.join(",")')).toMatchObject({ stdout: '[1, 2]\n"1,2"\n' });
  for (const source of ['p {a: 1}', 'p 1 { }', '"x".each_char { a: 1 }'])
    expect(run(source)).toMatchObject({ kind: 'compileError' });
  expect(run('p({a: 1})')).toMatchObject({ stdout: '{a: 1}\n' });
});

test('shadowed anonymous forwarding fails before execution', () => {
  expect(run('def f(*);[1].each{|*|p(*)};end;f(3)')).toMatchObject({ kind: 'compileError' });
});

test('class_eval visibility and numeric instance_eval definitions follow their receiver', () => {
  expect(run('C=Class.new;C.class_eval{private;define_method(:x){1}};p C.private_method_defined?(:x)')).toMatchObject({
    stdout: 'true\n',
  });
  expect(run('2.5.instance_exec{def f;1;end}')).toMatchObject({
    uncaughtException: "can't define singleton (TypeError)",
  });
});

test('condition flip-flops fail explicitly when unavailable', () => {
  expect(run('(1..10).each{|k|puts k if (k==3)..(k==5)}')).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ message: 'フリップフロップは、この採点環境では使えません。' }],
  });
});

test('pattern guard flip-flops fail explicitly before execution', () => {
  expect(run('3.times{|i|case i;in x if (x==1)..(x==2);p x;else;p :off;end}')).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ message: 'フリップフロップは、この採点環境では使えません。' }],
  });
});

test('pattern guards reject void expressions before execution', () => {
  expect(run('def f;case 1;in a if return;1;end;end;p f')).toMatchObject({ kind: 'compileError' });
});

test('large Integer quo retains finite Float results', () => {
  expect(run('p (10**400).quo(1e300),(10**400).quo(1e308)')).toMatchObject({
    stdout: '1.0e+100\n1.0e+92\n',
  });
});

test('strftime distinguishes unknown from truncated directives', () => {
  expect(
    run('begin; Time.utc(2024).strftime("100%"); rescue => e; p e.message; end; p Time.utc(2024).strftime("%Q")')
  ).toMatchObject({
    stdout: '"invalid format: 100%"\n"%Q"\n',
  });
});

test('strftime zero padding keeps negative signs at the front', () => {
  expect(run('p Time.at(-1).utc.strftime("%5s|%010s|%_5s")')).toMatchObject({
    stdout: '"-0001|-000000001|   -1"\n',
  });
});

test('DATA gets updates and clears the caller last line', () => {
  expect(run('$_="before";p DATA.gets;p $_;p DATA.gets;p $_\n__END__\na\n')).toMatchObject({
    stdout: '"a\\n"\n"a\\n"\nnil\nnil\n',
  });
});

test('String.new accepts negative capacity without changing text', () => {
  expect(run('p String.new(capacity:-1), String.new("abc",capacity:-3)')).toMatchObject({
    stdout: '""\n"abc"\n',
  });
});

test('Ruby capture names outside JavaScript syntax fail explicitly', () => {
  expect(run(String.raw`p /(?<日本-1>\w)/.names`)).toMatchObject({
    uncaughtException: '正規表現の特殊なキャプチャ名は、この採点環境では使えません。',
  });
});

test('rpartition handles a long quantified regexp at either end', () => {
  expect(
    run('p ("a"*50000).rpartition(/a+/).map(&:length), ("a"+"b"*50000).rpartition(/a+/).map(&:length)')
  ).toMatchObject({
    kind: 'executed',
    stdout: '[49999, 1, 0]\n[0, 1, 50000]\n',
  });
});

test('MatchData source snapshots preserve binary bytes and freezing', () => {
  expect(run('s=255.chr;m=/./.match(s);p m.string.encoding,m.string.bytes,m.string.frozen?')).toMatchObject({
    stdout: '#<Encoding:BINARY (ASCII-8BIT)>\n[255]\ntrue\n',
  });
  for (const source of [
    's=255.chr;/./=~s;p $~.string.encoding,$~.string.bytes',
    's=255.chr;s =~ /./;p $~.string.encoding,$~.string.bytes',
    'o=Object.new;def o.to_str;255.chr;end;m=/./.match(o);p m.string.encoding,m.string.bytes',
  ]) {
    expect(run(source)).toMatchObject({ stdout: '#<Encoding:BINARY (ASCII-8BIT)>\n[255]\n' });
  }
  for (const source of [
    's=255.chr;s.scan(/./){p $~.string.bytes}',
    's=255.chr;s.gsub(/./){p $~.string.bytes;"x"}',
    's=255.chr;s[/./];p $~.string.bytes',
  ]) {
    expect(run(source)).toMatchObject({ stdout: '[255]\n' });
  }
  for (const source of [
    's=255.chr;s.sub(255.chr){p $~.string.bytes;"x"}',
    's=255.chr;s.scan(255.chr){p $~.string.bytes}',
  ]) {
    expect(run(source)).toMatchObject({ stdout: '[255]\n' });
  }
  expect(run('s="aba";s.sub("a"){s[1]="X";"z"};p $~.string')).toMatchObject({ stdout: '"aba"\n' });
  expect(run('s="abc";s.sub!("a"){s[1]="X";"z"};p $~.string')).toMatchObject({ stdout: '"abc"\n' });
  expect(run('s="aba";i=0;s.gsub("a"){i+=1;s[1]="X" if i==2;"z"};p $~.string')).toMatchObject({
    stdout: '"aXa"\n',
  });
  expect(run('s="aba";i=0;s.gsub("a"){i+=1;s[2]="X" if i==2;"z"};p $~')).toMatchObject({ stdout: 'nil\n' });
  expect(run('s="aba";i=0;s.gsub("a"){i+=1;if i==2;s[2]="X";s[1]="a";end;"z"};p $~&.begin(0)')).toMatchObject({
    stdout: '1\n',
  });
  expect(run('s="éaba";i=0;s.gsub("a"){i+=1;s[0]="xx" if i==2;"z"};p $~&.begin(0),$~&.string')).toMatchObject({
    stdout: '4\n"xxaba"\n',
  });
  expect(run('m=/./.match(255.chr);p m[0].bytes,m.string.bytes,m[0].encoding')).toMatchObject({
    stdout: '[255]\n[255]\n#<Encoding:BINARY (ASCII-8BIT)>\n',
  });
  expect(run('a=/./.match("é");b=/./.match(233.chr);p a==b,a.eql?(b),{a=>1}[b]')).toMatchObject({
    stdout: 'false\nfalse\nnil\n',
  });
  expect(
    run(
      'begin;/é/.match?(233.chr);rescue=>e;p e.class,e.message;end;begin;Regexp.new(233.chr).match?("é");rescue=>e;p e.class,e.message;end'
    )
  ).toMatchObject({
    stdout:
      'Encoding::CompatibilityError\n"incompatible encoding regexp match (UTF-8 regexp with BINARY (ASCII-8BIT) string)"\nEncoding::CompatibilityError\n"incompatible encoding regexp match (BINARY (ASCII-8BIT) regexp with UTF-8 string)"\n',
  });
  expect(
    run('s=String.new("é",encoding:"US-ASCII");begin;s.match?(/x/);rescue=>e;p e.class,e.message;end')
  ).toMatchObject({
    stdout: 'ArgumentError\n"invalid byte sequence in US-ASCII"\n',
  });
  expect(run('p /./.match(233.chr)')).toMatchObject({ stdout: '#<MatchData "\\xE9">\n' });
  expect(run('s=255.chr;p s.split(/x/).first.bytes,s.partition(/x/).first.bytes,s[/./].bytes')).toMatchObject({
    stdout: '[255]\n[255]\n[255]\n',
  });
  expect(run('s=255.chr+"a"+254.chr;/a/.match(s);p $`.bytes,$\'.bytes')).toMatchObject({
    stdout: '[255]\n[254]\n',
  });
  expect(run('s=String.new("x",encoding:Encoding::ASCII_8BIT);p s.slice!(/(a)?x/,1).encoding')).toMatchObject({
    stdout: '#<Encoding:BINARY (ASCII-8BIT)>\n',
  });
  expect(run('s=255.chr;p s.partition(/x/).map(&:encoding),s.rpartition(/x/).map(&:encoding)')).toMatchObject({
    stdout: expect.stringContaining(
      '[#<Encoding:BINARY (ASCII-8BIT)>, #<Encoding:BINARY (ASCII-8BIT)>, #<Encoding:BINARY (ASCII-8BIT)>]'
    ),
  });
  expect(run('p 233.chr.gsub(/x/, "").bytes,233.chr.gsub(/x/, "").encoding')).toMatchObject({
    stdout: '[233]\n#<Encoding:BINARY (ASCII-8BIT)>\n',
  });
  expect(run(String.raw`p 233.chr.gsub(/./, "\\&").bytes`)).toMatchObject({ stdout: '[233]\n' });
  expect(
    run(
      's=String.new("a",encoding:"US-ASCII");p s.sub(/a/,"").encoding,s.sub(/a/,"b").encoding,"a".sub(/a/,65.chr).encoding,s.sub(/a/,"é").encoding'
    )
  ).toMatchObject({
    stdout: '#<Encoding:US-ASCII>\n#<Encoding:US-ASCII>\n#<Encoding:UTF-8>\n#<Encoding:UTF-8>\n',
  });
});

test('Time constructor validates field widths before calendar bounds', () => {
  expect(
    run(
      '[[2024,1,32],[2024,1,1,-1],[2024,16,1],[2024,1,1,24,1],[2024,1,1,24,0,1]].each{|a|begin;Time.utc(*a);rescue=>e;p e.message;end}'
    )
  ).toMatchObject({
    stdout:
      '"argument out of range"\n"argument out of range"\n"argument out of range"\n"min out of range"\n"sec out of range"\n',
  });
  expect(run('begin;Time.utc(nil);rescue=>e;p e.class,e.message;end')).toMatchObject({
    stdout: 'TypeError\n"no implicit conversion of nil into Integer"\n',
  });
  expect(
    run('[Float::NAN,Float::INFINITY].each{|s|begin;Time.utc(2024,1,1,0,0,s);rescue=>e;p e.class,e.message;end}')
  ).toMatchObject({ stdout: 'FloatDomainError\n"NaN"\nFloatDomainError\n"Infinity"\n' });
  expect(run('begin;Time.utc(2024,1,1,0,0,0,0,1,2);rescue=>e;p e.class,e.message;end')).toMatchObject({
    stdout: 'ArgumentError\n"wrong number of arguments (given 9, expected 1..8)"\n',
  });
  expect(run('begin;Time.utc(2024,"February");rescue=>e;p e.class;end')).toMatchObject({ stdout: 'ArgumentError\n' });
  expect(run('p Time.at(0).getlocal("-00:00").utc?,Time.at(0).getlocal("-0000").zone')).toMatchObject({
    stdout: 'true\n"UTC"\n',
  });
});

test('Hash value transforms retain identity comparison', () => {
  expect(
    run(
      'h={}.compare_by_identity;a="a";b="a";h[a]=1;h[b]=2;v=h.transform_values{|x|x};p v,v.size,v.compare_by_identity?'
    )
  ).toMatchObject({ stdout: '{"a" => 1, "a" => 2}\n2\ntrue\n' });
});

test('respond_to_missing? definitions remain private', () => {
  expect(
    run(
      'class D;def respond_to_missing?(n,p=false);true;end;end;d=D.new;p defined?(d.respond_to_missing?);begin;d.respond_to_missing?(:x);rescue=>e;p e.class;end'
    )
  ).toMatchObject({ stdout: 'nil\nNoMethodError\n' });
  expect(
    run(
      'class C;def self.respond_to_missing?(n,p=false);true;end;end;p C.respond_to_missing?(:x),C.singleton_class.private_method_defined?(:respond_to_missing?)'
    )
  ).toMatchObject({ stdout: 'true\nfalse\n' });
  expect(
    run(
      'class D;private;def hidden;end;def respond_to_missing?(n,p=false);true;end;end;p D.new.respond_to?(:hidden),D.new.respond_to?(:respond_to_missing?)'
    )
  ).toMatchObject({ stdout: 'true\ntrue\n' });
});

test('DATA inspect identifies its script file', () => {
  expect(run('p DATA\n__END__\ntext')).toMatchObject({ stdout: '#<File:main.rb>\n' });
  expect(run('p DATA.to_s\n__END__\ntext')).toMatchObject({
    stdout: expect.stringMatching(/^"#<File:0x[\da-f]+>"\n$/),
  });
});

test('Regexp encoding and matching respect escaped characters and binary subjects', () => {
  expect(run(String.raw`p /\u00E9/.encoding;begin;/\u00E9/.match?(233.chr);rescue=>e;p e.class;end`)).toMatchObject({
    stdout: '#<Encoding:UTF-8>\nEncoding::CompatibilityError\n',
  });
  expect(run('a=Regexp.new("é");b=Regexp.new(233.chr);p a==b,a.eql?(b),{a=>1}[b]')).toMatchObject({
    stdout: 'false\nfalse\nnil\n',
  });
  expect(run(String.raw`s="\xFF";begin;/./.match(s,99);rescue=>e;p e.class,e.message;end`)).toMatchObject({
    stdout: 'ArgumentError\n"invalid byte sequence in UTF-8"\n',
  });
  expect(run(String.raw`s="\xFF";p /./.match(s,-99);begin;s.match(/./,99);rescue=>e;p e.class;end`)).toMatchObject({
    stdout: 'nil\nArgumentError\n',
  });
});

test('large US-ASCII Regexp scans retain every match', () => {
  expect(run('p String.new("a"*20000,encoding:"US-ASCII").scan(/./).size')).toMatchObject({ stdout: '20000\n' });
});

test('large Unicode-alternative Regexp scans retain every match', () => {
  expect(run('p ("a"*20000).scan(/é|a/).size')).toMatchObject({ stdout: '20000\n' });
});

test('Regexp exact intervals followed by question marks retain optional repetition', () => {
  expect(
    run(`p "a"[/a{2}?/]
p "xaaay".sub(/(a){2}?/, "-")
p "aaaa".scan(/a{2}?/)
p "aaaa".scan(/a{2}??/)
p "aaaa".scan(/a{2,3}?/)
p "aaaa".scan(/a{2,3}??/)
`)
  ).toMatchObject({
    kind: 'executed',
    stdout: '""\n"-xaaay"\n["aa", "aa", ""]\n["", "", "", "", ""]\n["aa", "aa"]\n["aa", "aa", ""]\n',
  });
});

test('BasicObject receives block instance evaluation', () => {
  expect(run('class B < BasicObject;def run;instance_eval{1};end;end;p B.new.run')).toMatchObject({ stdout: '1\n' });
});

test('numeric conversions call dynamic responders', () => {
  const source =
    'class D;def method_missing(m,*a);return 5 if m==:to_i;return 2.5 if m==:to_f;return [a[0],11] if m==:coerce;super;end;end;p Integer(D.new),Float(D.new),1+D.new';
  expect(run(source)).toMatchObject({ stdout: '5\n2.5\n12\n' });
});

test('nested evaluation keeps its own definition visibility and target', () => {
  expect(run('C=Class.new;C.class_eval{private;1.times{def x;1;end}};p C.private_method_defined?(:x)')).toMatchObject({
    stdout: 'true\n',
  });
  expect(
    run('C=Class.new;C.class_eval{protected;define_method(:x){1}};p C.protected_method_defined?(:x)')
  ).toMatchObject({
    stdout: 'true\n',
  });
  expect(run('C=Class.new;1.instance_eval{C.class_eval{def f;1;end}};p C.new.f')).toMatchObject({ stdout: '1\n' });
});

test('Struct dig accepts singleton dig implementations', () => {
  expect(run('S=Struct.new(:x);v=Object.new;def v.dig(k);[k];end;p S.new(v).dig(:x,:y)')).toMatchObject({
    stdout: '[:y]\n',
  });
});

test('quoted pattern shorthand requires a literal local name', () => {
  expect(run('case {a:1};in {"A":};p :ok;end')).toMatchObject({ kind: 'compileError' });
  expect(run(String.raw`case {a:1};in {"\u0061":};p a;end`)).toMatchObject({ kind: 'compileError' });
});

test('Lazy size calculations retain exact accepted counts', () => {
  expect(run('p (1..).lazy.take(2**63-1).size')).toMatchObject({ stdout: '9223372036854775807\n' });
});

test('negated and combined flip-flops fail before execution', () => {
  expect(run('(1..10).each{|k|puts k if !((k==3)..(k==5))}')).toMatchObject({ kind: 'compileError' });
  expect(run('(1..10).each{|k|puts k if true && ((k==3)..(k==5))}')).toMatchObject({
    kind: 'compileError',
  });
});

test('strftime pads composite dates before their negative year', () => {
  expect(run('p Time.utc(-1).strftime("%015F")')).toMatchObject({ stdout: '"0000-0001-01-01"\n' });
});

test('numeric step treats an explicit nil step as omitted', () => {
  expect(run('p 1.step(3,nil).to_a,1.0.step(3,nil).to_a')).toMatchObject({
    stdout: '[1, 2, 3]\n[1.0, 2.0, 3.0]\n',
  });
  expect(run('begin;1.step(3,nil){|x|p x};rescue=>e;p e.class,e.message;end')).toMatchObject({
    stdout: 'TypeError\n"step must be numeric"\n',
  });
  expect(run('p 1.step(3,nil).inspect')).toMatchObject({ stdout: '"(1.step(3, nil))"\n' });
});

test('Rational supports implicit integer conversion', () => {
  expect(run('p 3r.to_int,[1,2].last(3r),(2r/3).to_int')).toMatchObject({
    stdout: '3\n[1, 2]\n0\n',
  });
});

test('large regexp replacements process short literal fragments within the budget', () => {
  expect(run(String.raw`r="x\\1"*200000;p "a".sub(/(b)?a/,r).size`)).toMatchObject({ stdout: '200000\n' });
});

test('pattern shorthand accepts uncased Unicode local names', () => {
  expect(run('case {名前:1};in {"名前":};p 名前;end')).toMatchObject({ stdout: '1\n' });
});

test('literal condition ranges are unavailable flip-flops', () => {
  expect(run('if (1..2);p :ran;end')).toMatchObject({ kind: 'compileError' });
  expect(run('x=true;if x && (1..2);p :ran;end')).toMatchObject({ kind: 'compileError' });
});

test('Enumerator Generator includes Enumerable', () => {
  expect(run('g=Enumerator::Generator.new{|y|y<<1<<2};p g.respond_to?(:to_a),g.map{|x|x*2},g.to_a')).toMatchObject({
    stdout: 'true\n[2, 4]\n[1, 2]\n',
  });
  expect(run('g=Enumerator::Generator.new{|y|y<<1};begin;g.each;rescue=>e;p e.class,e.message;end')).toMatchObject({
    stdout: 'LocalJumpError\n"no block given"\n',
  });
});

test('Time calendar constructors classify trailing arguments', () => {
  expect(run('p Time.utc(2020,1,1,1,1,1,1,9).nsec,Time.local(2020,1,1,1,1,1,1,9).nsec')).toMatchObject({
    stdout: '0\n0\n',
  });
  expect(run('begin;Time.utc(2020,1,1,1,1,1,"x");rescue=>e;p e.class,e.message;end')).toMatchObject({
    stdout: 'ArgumentError\n"invalid value for Integer(): \\"x\\""\n',
  });
});

test('Class inherited hooks can call their default with super', () => {
  expect(
    run(
      'class Base\ndef self.inherited(sub)\nsuper\n@subs=sub\nend\ndef self.subs\n@subs\nend\nend\nclass Kid < Base\nend\np Base.subs'
    )
  ).toMatchObject({
    stdout: 'Kid\n',
  });
});

test('nested blocks share their lexical definition visibility', () => {
  expect(run('C=Class.new;C.class_eval{1.times{private};def x;1;end};p C.private_method_defined?(:x)')).toMatchObject({
    stdout: 'true\n',
  });
  expect(run('C=Class.new{1.times{private};define_method(:x){1}};p C.private_method_defined?(:x)')).toMatchObject({
    stdout: 'true\n',
  });
});

test('dynamic conversion preserves exceptions raised inside its hook', () => {
  expect(
    run(
      'class C;def respond_to_missing?(n,*);n==:to_str||super;end;def method_missing(n,*);return Object.new.foo if n==:to_str;super;end;end;begin;[1].join(C.new);rescue=>e;p e.class,e.name;end'
    )
  ).toMatchObject({
    stdout: 'NoMethodError\n:foo\n',
  });
});

test('multi assignment rescue wraps the right-hand values', () => {
  expect(run('a,b=1,Integer("x") rescue 7;p [a,b]')).toMatchObject({ stdout: '[7, nil]\n' });
  expect(run('a,b=1,2 rescue puts "z"')).toMatchObject({ kind: 'compileError' });
});

test('hash pattern remainder keeps identity key comparison', () => {
  expect(
    run('a="x";b="x";h={}.compare_by_identity;h[a]=1;h[b]=2;h=>{**rest};p rest,rest.compare_by_identity?')
  ).toMatchObject({
    stdout: '{"x" => 1, "x" => 2}\ntrue\n',
  });
});

test('pattern failure describes the deconstructed array', () => {
  expect(run('S=Struct.new(:a);begin;S.new(1)=>[x,y];rescue NoMatchingPatternError=>e;p e.message;end')).toMatchObject({
    stdout: '"#<struct S a=1>: [1] length mismatch (given 1, expected 2)"\n',
  });
});

test('lexical definition target survives ordinary nested blocks', () => {
  expect(run('class C;1.times{private};def x;1;end;end;p C.private_method_defined?(:x)')).toMatchObject({
    stdout: 'true\n',
  });
  expect(
    run(
      'module M;end;M.module_eval{1.times{module_function};def x;1;end};p M.respond_to?(:x),M.private_method_defined?(:x)'
    )
  ).toMatchObject({
    stdout: 'true\ntrue\n',
  });
});

test('Time calendar seconds reject fractional string fields', () => {
  expect(run('begin;Time.utc(1970,1,1,0,0,"0.1");rescue=>e;p e.class,e.message;end')).toMatchObject({
    stdout: 'ArgumentError\n"invalid value for Integer(): \\"0.1\\""\n',
  });
});

test('Struct values_at converts each selector once', () => {
  expect(
    run('class I;def initialize;@n=-1;end;def to_int;@n+=1;end;end;s=Struct.new(:a,:b).new(10,20);p s.values_at(I.new)')
  ).toMatchObject({
    stdout: '[10]\n',
  });
});

test('aliases reject unsupported method-added hooks', () => {
  expect(
    run('module H;def method_added(n);p n;end;end;class C;def x;end;extend H;alias_method :y,:x;end')
  ).toMatchObject({
    uncaughtException: expect.stringContaining('メソッド・定数フック'),
  });
});

test('custom not-match operators dispatch to their receiver', () => {
  expect(run('class M;def !~(other);:custom;end;end;p M.new !~ "x", "a" !~ /b/')).toMatchObject({
    stdout: ':custom\ntrue\n',
  });
});

test('defined recognizes the special last-line global', () => {
  expect(run('p defined?($_);$_="x";p defined?($_)')).toMatchObject({
    stdout: '"global-variable"\n"global-variable"\n',
  });
});

test('literal searches inspect MatchData with the colon form', () => {
  expect(run('"abc".sub("b","x");p $~')).toMatchObject({ stdout: '#<MatchData: b>\n' });
});

test('keyword expansion rehashes keys across identity modes', () => {
  expect(run('def f(**k);p k,k[:a],k.key?(:a);end;h={a:42}.compare_by_identity;f(**h)')).toMatchObject({
    stdout: '{a: 42}\n42\ntrue\n',
  });
});

test('unsupported const_missing definitions fail before lookup', () => {
  expect(run('class C;def self.const_missing(n);1;end;end;p C::X')).toMatchObject({
    uncaughtException: expect.stringContaining('メソッド・定数フック'),
  });
});

test('define_method follows module_function mode', () => {
  expect(run('module M;module_function;define_method(:x){1};end;p M.x,M.private_method_defined?(:x)')).toMatchObject({
    stdout: '1\ntrue\n',
  });
});

test('hash pattern remainders retain their default', () => {
  expect(run('h=Hash.new(7);h[:x]=1;h=>{**r};p r.default,r[:z]')).toMatchObject({ stdout: '7\n7\n' });
});

test('Class.new establishes its own definition target inside eval', () => {
  expect(
    run('c=Class.new;d=c.class_eval{Class.new{def x;1;end}};p d.method_defined?(:x),c.method_defined?(:x)')
  ).toMatchObject({
    stdout: 'true\nfalse\n',
  });
});

test('multiple unmatched patterns use the subject string as their message', () => {
  expect(run('begin;case "str";in 1;in 2;end;rescue=>e;p e.message;end')).toMatchObject({ stdout: '"str"\n' });
  expect(run('begin;case nil;in 1;in 2;end;rescue=>e;p e.message;end')).toMatchObject({
    stdout: '"NoMatchingPatternError"\n',
  });
});

test('empty String initialization preserves existing bytes and encoding', () => {
  expect(run('s="é".freeze;s.send(:initialize);p s.encoding,s.bytes')).toMatchObject({
    stdout: '#<Encoding:UTF-8>\n[195, 169]\n',
  });
  expect(run('p String.new.encoding,String.allocate.encoding')).toMatchObject({
    stdout: '#<Encoding:BINARY (ASCII-8BIT)>\n#<Encoding:BINARY (ASCII-8BIT)>\n',
  });
});

test('Struct values_at reads fields before later selector conversions', () => {
  expect(
    run('S=Struct.new(:x,:y);s=S.new(1,2);i=Object.new;i.define_singleton_method(:to_int){s.x=9;1};p s.values_at(0,i)')
  ).toMatchObject({
    stdout: '[1, 2]\n',
  });
});

test('Struct.new defines an empty anonymous Struct class', () => {
  expect(run('S=Struct.new;p S.new.members,S.new.inspect')).toMatchObject({ stdout: '[]\n"#<struct S>"\n' });
});

test('method lookup names singleton classes in errors', () => {
  expect(run('begin;Object.method(:zz);rescue=>e;p e.message;end')).toMatchObject({
    stdout: "\"undefined method 'zz' for class '#<Class:Object>'\"\n",
  });
});

test('Kernel not-match can invoke a private match operator', () => {
  expect(run('class C;private;def =~(x);1;end;end;p C.new !~ 1')).toMatchObject({ stdout: 'false\n' });
});

test('Struct initialization clears members omitted on later calls', () => {
  expect(run('S=Struct.new(:a,:b);s=S.new(1,2);s.send(:initialize,3);p s')).toMatchObject({
    stdout: '#<struct S a=3, b=nil>\n',
  });
});

test('Struct deconstruct_keys keeps requested key forms', () => {
  expect(
    run('s=Struct.new(:a,:b).new(1,2);p s.deconstruct_keys(["a"]),s.deconstruct_keys([0]),s.deconstruct_keys([-1])')
  ).toMatchObject({
    stdout: '{"a" => 1}\n{0 => 1}\n{-1 => 2}\n',
  });
});

test('Struct iteration enumerators report member count', () => {
  expect(run('s=Struct.new(:a,:b).new;p s.each.size,s.each_pair.size')).toMatchObject({ stdout: '2\n2\n' });
});

test('Struct keyword initialization updates known members before an error', () => {
  expect(
    run(
      'S=Struct.new(:a,:b,keyword_init:true);s=S.new(a:1,b:2);begin;s.send(:initialize,a:3,z:4);rescue=>e;p e.class;end;p s'
    )
  ).toMatchObject({
    stdout: 'ArgumentError\n#<struct S a=3, b=nil>\n',
  });
});

test('Class.new alias and undef use its definition owner', () => {
  expect(run('c=Class.new do;def a;1;end;alias b a;end;p c.new.b')).toMatchObject({ stdout: '1\n' });
  expect(run('c=Class.new do;def a;1;end;undef a;end;p c.new.respond_to?(:a)')).toMatchObject({
    stdout: 'false\n',
  });
});

test('anonymous empty Struct and Data keep their inspect spacing', () => {
  expect(run('x=Struct.new;p x.new.inspect;d=Data.define;p d.new.inspect')).toMatchObject({
    stdout: '"#<struct >"\n"#<data >"\n',
  });
});

test('main method lookup describes its singleton class', () => {
  expect(run('begin;method(:zz);rescue=>e;p e.message;end')).toMatchObject({
    stdout: expect.stringMatching(/for class '#<Class:#<Object:0x[\da-f]+>>'/),
  });
});

test('Struct range selectors read values after endpoint conversion', () => {
  expect(
    run('S=Struct.new(:a,:b);s=S.new(1,2);i=Object.new;i.define_singleton_method(:to_int){s.a=9;0};p s.values_at(i..i)')
  ).toMatchObject({
    stdout: '[9]\n',
  });
});

test('Time accepts boxed Float offsets and integer string separators', () => {
  expect(run('p Time.new(2024,1,1,0,0,0,-0.0).utc_offset,Time.utc(2000,1,1,0,0,"1_0").sec')).toMatchObject({
    stdout: '0\n10\n',
  });
});

test('Rational coerce accepts Rational operands', () => {
  expect(run('p Rational(1,2).coerce(Rational(1,3))')).toMatchObject({ stdout: '[(1/3), (1/2)]\n' });
});

test('named regexp replacement ignores numeric capture references', () => {
  expect(run(String.raw`p "abc".gsub(/(?<x>a)/,%q{\1})`)).toMatchObject({ stdout: '"bc"\n' });
});

test('default method_missing leaves advertised conversions absent', () => {
  expect(
    run('class C;def respond_to_missing?(n,*);n==:to_ary||super;end;end;begin;[1]+C.new;rescue=>e;p e.class;end')
  ).toMatchObject({
    stdout: 'TypeError\n',
  });
});

test('hash pattern remainder copying avoids key hash callbacks', () => {
  expect(run('class K;def hash;$n+=1;1;end;end;$n=0;h={K.new=>1};$n=0;h=>{**r};p $n,r.size')).toMatchObject({
    stdout: '0\n1\n',
  });
});

test('repeated regexp matches reuse unchanged source snapshots', () => {
  expect(run('n=0;("a"*20000).scan(/./){|x|n+=1};p n')).toMatchObject({ stdout: '20000\n' });
  expect(run('p ("a"*20000).gsub(/./,"b").size')).toMatchObject({ stdout: '20000\n' });
});

test('Rational arithmetic uses private coerce methods', () => {
  expect(run('class A;private;def coerce(v);[v,1];end;end;p 1r+A.new')).toMatchObject({ stdout: '(2/1)\n' });
});

test('Regexp.new rejects unknown option letters', () => {
  expect(run('begin;Regexp.new("a","bad");rescue=>e;p e.class,e.message;end')).toMatchObject({
    stdout: 'ArgumentError\n"unknown regexp option: bad"\n',
  });
});

test('Struct rejects member names ending in equals', () => {
  expect(run('begin;Struct.new(:"a=");rescue=>e;p e.class,e.message;end')).toMatchObject({
    stdout: 'ArgumentError\n"invalid struct member: a="\n',
  });
});

test('external iterator reentrancy raises Ruby FiberError', () => {
  expect(run('e=Enumerator.new{|y|e.next};begin;e.next;rescue=>x;p x.class,x.message;end')).toMatchObject({
    stdout: 'FiberError\n"attempt to resume the current fiber"\n',
  });
});

test('Rational comparisons coerce custom numeric values', () => {
  expect(run('class B;def coerce(v);[v,2];end;end;p 1r.send(:<=>,B.new);p(1r<B.new)')).toMatchObject({
    stdout: '-1\ntrue\n',
  });
});

test('Data with bypasses overridden public constructors', () => {
  expect(run('D=Data.define(:x);d=D.new(1);def D.new(**k);puts :custom;:other;end;p d.with(x:2)')).toMatchObject({
    stdout: '#<data D x=2>\n',
  });
});

test('bare Struct and Data classes reject allocation', () => {
  expect(run('begin;Struct.allocate.to_a;rescue=>e;p e.class,e.message;end')).toMatchObject({
    stdout: 'TypeError\n"allocator undefined for Struct"\n',
  });
  expect(run('begin;Data.allocate.deconstruct;rescue=>e;p e.class,e.message;end')).toMatchObject({
    stdout: 'TypeError\n"allocator undefined for Data"\n',
  });
});

test('Module const_get includes Object constants with inheritance', () => {
  expect(run('module N;end;module M;end;p M.const_get("N")==N,M.const_defined?(:N)')).toMatchObject({
    stdout: 'true\ntrue\n',
  });
});

test('the last match global accepts nil assignments', () => {
  expect(run('$~ = nil;p $~')).toMatchObject({ stdout: 'nil\n' });
});

test('nested regexp character classes fail explicitly', () => {
  expect(run('p "b" =~ /[a[bc]]/')).toMatchObject({
    uncaughtException: expect.stringContaining('入れ子の文字クラスは、この採点環境では使えません。'),
  });
});

test('Symbol regexp methods and nil Rational conversion remain available', () => {
  expect(run('p :abc.match(/a/),:abc.match?(/a/),:abc.encoding,nil.to_r')).toMatchObject({
    stdout: '#<MatchData "a">\ntrue\n#<Encoding:US-ASCII>\n(0/1)\n',
  });
});

test('MatchData named captures accept symbol keys', () => {
  expect(run('m=/(?<a>1)(?<b>2)/.match("12");p m.named_captures(symbolize_names:true)')).toMatchObject({
    stdout: '{a: "1", b: "2"}\n',
  });
});

test('MatchData deconstruct_keys rejects surplus requested keys', () => {
  expect(run('m=/(?<a>1)(?<b>2)/.match("12");p m.deconstruct_keys([:a,:b,:c])')).toMatchObject({
    stdout: '{}\n',
  });
});

test('Struct range selectors validate the first endpoint before the second', () => {
  expect(
    run(
      's=Struct.new(:a).new(1);i=Object.new;j=Object.new;def i.<=>(x);0;end;def i.to_int;2**100;end;def j.to_int;puts :end;0;end;r=i..j;begin;s.values_at(r);rescue=>e;p e.class;end'
    )
  ).toMatchObject({
    stdout: 'RangeError\n',
  });
});

test('named regexp replacement keeps the whole-match zero reference', () => {
  expect(run(String.raw`p "abc".sub(/(?<x>a)/,%q{\0})`)).toMatchObject({ stdout: '"abc"\n' });
});

test('Data deconstruct_keys rejects positional keys', () => {
  expect(run('begin;Data.define(:a).new(1).deconstruct_keys([0]);rescue=>e;p e.class,e.message;end')).toMatchObject({
    stdout: 'TypeError\n"0 is not a symbol nor a string"\n',
  });
});

test('Data deconstruct_keys converts string-like keys', () => {
  expect(
    run('d=Data.define(:a).new(1);o=Object.new;def o.to_str;puts :converted;"a";end;p d.deconstruct_keys([o])')
  ).toMatchObject({
    stdout: 'converted\n{"a" => 1}\n',
  });
});

test('MatchData snapshots preserve String subclasses', () => {
  expect(
    run('class S<String;end;s=S.new("a");m=/a/.match(s);p m.string.class,m.string.frozen?,m.string.equal?(s)')
  ).toMatchObject({
    stdout: 'S\ntrue\nfalse\n',
  });
});

test('Data deconstruct_keys reports invalid to_str results', () => {
  expect(
    run(
      'd=Data.define(:a).new(1);o=Object.new;def o.to_str;1;end;begin;d.deconstruct_keys([o]);rescue=>e;p e.class,e.message;end'
    )
  ).toMatchObject({
    stdout: 'TypeError\n"can\'t convert Object to String (Object#to_str gives Integer)"\n',
  });
});

test('local variables followed by operator-like syntax stay local reads', () => {
  expect(run('def fib(n)\nreturn n if n<2\nfib(n -1)+fib(n -2)\nend\np fib(10)')).toMatchObject({
    stdout: '55\n',
  });
  expect(run('n=3;def g(a,b);a+b;end;p g(n -1,2)')).toMatchObject({ stdout: '4\n' });
  expect(run('x=5;puts x *2')).toMatchObject({ stdout: '10\n' });
  expect(run('x=[1,2];p x [0]')).toMatchObject({ stdout: '1\n' });
});

test('DATA rejects inherited write methods with Ruby IOError', () => {
  expect(run('begin;DATA.write("x");rescue=>e;p e.class,e.message;end\n__END__\na\n')).toMatchObject({
    stdout: 'IOError\n"not opened for writing"\n',
  });
});

test('DATA retains read-only IO queries and flushing', () => {
  expect(
    run('p DATA.flush.equal?(DATA),DATA.fsync,DATA.sync,DATA.sync=true,DATA.tty?,DATA.isatty,DATA.read\n__END__\na\n')
  ).toMatchObject({ stdout: 'true\n0\nfalse\ntrue\nfalse\nfalse\n"a\\n"\n' });
});

test('standard streams expose Ruby default sync modes', () => {
  expect(run('p $stdout.sync,$stderr.sync,STDOUT.sync')).toMatchObject({ stdout: 'false\ntrue\nfalse\n' });
});

test('Time string offsets accept compact seconds and reject mixed separators', () => {
  expect(
    run('p Time.at(0).getlocal("+090001").utc_offset;begin;Time.at(0).getlocal("+0900:01");rescue=>e;p e.class;end')
  ).toMatchObject({ stdout: '32401\nArgumentError\n' });
});

test('compact negative zero offsets retain UTC identity', () => {
  expect(run('t=Time.at(0).getlocal("-000000");p t.utc?,t.zone,t.to_s')).toMatchObject({
    stdout: 'true\n"UTC"\n"1970-01-01 00:00:00 UTC"\n',
  });
});

test('Lazy each_cons reports its own invalid size error', () => {
  expect(run('begin;[].lazy.each_cons(0);rescue=>e;p e.message;end')).toMatchObject({
    stdout: '"invalid size"\n',
  });
});

test('frozen String capacity initialization raises after conversion', () => {
  expect(
    run('class S<String;def initialize;freeze;super(capacity:10);end;end;begin;S.new;rescue=>e;p e.class;end')
  ).toMatchObject({
    stdout: 'FrozenError\n',
  });
});

test('DATA file descriptor is explicitly unavailable', () => {
  expect(run('DATA.fileno\n__END__\nx\n')).toMatchObject({
    uncaughtException: 'DATA.fileno は、この採点環境では使えません。',
  });
});

test('Time to_s omits second digits from numeric UTC offsets', () => {
  expect(run('p Time.at(0).getlocal(1).to_s')).toMatchObject({ stdout: '"1970-01-01 00:00:01 +0000"\n' });
});

test('BasicObject exposes __send__ without Kernel', () => {
  expect(run('class Proxy<BasicObject;def greet;42;end;end;::Kernel.p Proxy.new.__send__(:greet)')).toMatchObject({
    stdout: '42\n',
  });
});

test('Symbol String-equivalent methods accept supported Regexps', () => {
  expect(run('p :abc[/b./],:abc.slice(/b(.)/,1),:abc.start_with?(/a/)')).toMatchObject({
    stdout: '"bc"\n"c"\ntrue\n',
  });
});

test('Symbol to_proc retains its required receiver parameter', () => {
  expect(run('p :to_s.to_proc.arity,:to_s.to_proc.parameters,:to_s.to_proc.parameters(lambda:false)')).toMatchObject({
    stdout: '-2\n[[:req], [:rest]]\n[[:req], [:rest]]\n',
  });
});

test('defined? keeps its actual block context for implicit parameters', () => {
  expect(run('p defined?(it),defined?(_1)')).toMatchObject({ stdout: 'nil\nnil\n' });
});

test('frozen DATA reports FrozenError before read-only write errors', () => {
  expect(
    run(
      'DATA.freeze;[:write,:puts,:print,:printf,:putc].each{|m|begin;DATA.send(m,"x");rescue=>e;p e.class;end};begin;DATA << "x";rescue=>e;p e.class;end\n__END__\na\n'
    )
  ).toMatchObject({ stdout: 'FrozenError\nFrozenError\nFrozenError\nFrozenError\nFrozenError\nFrozenError\n' });
});

test('single IO writes convert before validation and allow empty output', () => {
  expect(
    run(
      'DATA.freeze;p DATA.write(""),DATA.write(nil),DATA.print(""),DATA.print(nil),DATA.printf(""),DATA << "",DATA.putc("");class O;def to_s;puts :converted;raise "conversion";end;end;begin;DATA.write(O.new);rescue=>e;p e.class;end;begin;DATA.write("","");rescue=>e;p e.class;end\n__END__\na\n'
    )
  ).toMatchObject({
    stdout: '0\n0\nnil\nnil\nnil\n#<File:main.rb>\n""\nconverted\nRuntimeError\nFrozenError\n',
  });
});

test('anonymous pattern rest avoids materializing discarded arrays', () => {
  expect(run('items=(1..20000).to_a;sum=0;100.times{items=>[head,*];sum+=head;items.shift};p sum')).toMatchObject({
    stdout: '5050\n',
  });
});

test('infinite Time offsets raise FloatDomainError', () => {
  expect(run('begin;Time.at(0).getlocal(Float::INFINITY);rescue=>e;p e.class,e.message;end')).toMatchObject({
    stdout: 'FloatDomainError\n"Infinity"\n',
  });
});

test('finite exact Time offsets report range errors before Float overflow', () => {
  expect(run('begin;Time.at(0).getlocal(10**400);rescue=>e;p e.class,e.message;end')).toMatchObject({
    stdout: 'ArgumentError\n"utc_offset out of range"\n',
  });
});

test('exact fractional Time offsets stay in range near the limit', () => {
  expect(
    run('x=Rational(86400*10**15-1,10**15);p Time.at(0).getlocal(x).utc_offset,Time.at(0).getlocal(-x).utc_offset')
  ).toMatchObject({
    stdout: '(86399999999999999999/1000000000000000)\n(-86399999999999999999/1000000000000000)\n',
  });
});

test('Encoding singleton values are frozen', () => {
  expect(run('p Encoding::UTF_8.frozen?,Encoding::ASCII_8BIT.frozen?')).toMatchObject({ stdout: 'true\ntrue\n' });
});

test('instance_exec and class_exec forward keyword arguments', () => {
  expect(run('Object.new.instance_exec(x:1){|x:|p x};Class.new.class_exec(x:2){|x:|p x}')).toMatchObject({
    stdout: '1\n2\n',
  });
});

test('substitution blocks retain their own last regexp match', () => {
  expect(run('"a".sub(/a/){/b/=~"b";"x"};p $&')).toMatchObject({ stdout: '"b"\n' });
  expect(run('"a".sub("a"){/b/=~"b";"x"};p $&')).toMatchObject({ stdout: '"b"\n' });
});

test('replacement Hash callbacks retain their own last regexp match', () => {
  expect(
    run('h=Hash.new{|_,k|/b/=~"b";"x"};"a".sub(/a/,h);p $&;"a".sub("a",h);p $&;s="a";s.sub!(/a/,h);p $&')
  ).toMatchObject({ stdout: '"b"\n"b"\n"b"\n' });
});

test('extended regexps retain non-ASCII whitespace and vertical tabs', () => {
  expect(run('p(/a b/x.match?("ab"),/a b/x.match?("a b"),/a\vb/x.match?("a\vb"),/a b/x.match?("ab"))')).toMatchObject({
    stdout: 'false\ntrue\ntrue\ntrue\n',
  });
});

test('implicit conversion respects a negative respond_to_missing? answer', () => {
  expect(
    run(
      String.raw`class Ghost;def method_missing(name,*);puts "missing: #{name}";super;end;def respond_to_missing?(name,ip=false);false;end;def to_s;"Ghost";end;end;g=Ghost.new;puts g;p [g,g].flatten.size;print g,"\n"`
    )
  ).toMatchObject({ stdout: 'Ghost\n2\nGhost\n' });
});

test('BasicObject implicit conversion respects respond_to_missing?', () => {
  expect(
    run(
      'class Ghost < BasicObject;def method_missing(n,*);::Kernel.puts "missing: #{n}";super;end;def respond_to_missing?(n,p=false);false;end;end;g=Ghost.new;p [g].flatten.size'
    )
  ).toMatchObject({ stdout: '1\n' });
});

test('Struct index conversion occurs once on an out-of-range access', () => {
  expect(
    run('class Index;def to_int;puts :called;4;end;end;begin;Struct.new(:a).new[Index.new];rescue=>e;p e.message;end')
  ).toMatchObject({ stdout: 'called\n"offset 4 too large for struct(size:1)"\n' });
});

test('Method to_proc retains reflected parameter names and kinds', () => {
  expect(
    run('def reflected(x,y:1);end;p method(:reflected).to_proc.parameters,method(:reflected).parameters')
  ).toMatchObject({
    stdout: '[[:req, :x], [:key, :y]]\n[[:req, :x], [:key, :y]]\n',
  });
  expect(run('def reflected(x,y:1);end;p method(:reflected).to_proc.parameters(lambda:false)')).toMatchObject({
    stdout: '[[:opt, :x], [:key, :y]]\n',
  });
  expect(
    run(
      'def reflected(x,y:1);end;p method(:reflected).to_proc.dup.parameters,method(:reflected).to_proc.clone.parameters'
    )
  ).toMatchObject({
    stdout: '[[:req, :x], [:key, :y]]\n[[:req, :x], [:key, :y]]\n',
  });
});

test('qualified constant reflection excludes Object ancestors in nested paths', () => {
  expect(
    run(
      'class N;end;X=7;module M;N=::N;end;begin;p M.const_get("N::X");rescue=>e;p e.class;end;p M.const_defined?("N::X")'
    )
  ).toMatchObject({ stdout: 'NameError\nfalse\n' });
});

test('Range size handles Rational ends and rejects non-successor begins', () => {
  expect(run('p (1..3r).size,(1...7/2r).size,(1..3r).each_slice(2).size')).toMatchObject({
    stdout: '3\n3\n2\n',
  });
  expect(
    run(
      'begin;p (1r..3r).size;rescue=>e;p e.class,e.message;end;begin;p (Time.at(0)..Time.at(5)).size;rescue=>e;p e.class,e.message;end'
    )
  ).toMatchObject({ stdout: 'TypeError\n"can\'t iterate from Rational"\nTypeError\n"can\'t iterate from Time"\n' });
});

test('Range size consults dynamic successor responders', () => {
  expect(
    run(
      'class C;def <=>(x);0;end;def respond_to_missing?(n,*);n==:succ;end;def method_missing(n,*);self;end;end;p (C.new..C.new).size'
    )
  ).toMatchObject({ stdout: 'nil\n' });
  expect(
    run(
      'class C;def <=>(x);0;end;def succ;self;end;def respond_to?(n,*);false;end;end;begin;p (C.new..C.new).size;rescue=>e;p e.class;end'
    )
  ).toMatchObject({ stdout: 'TypeError\n' });
  expect(
    run('class C;def <=>(x);0;end;def succ;self;end;private;def respond_to?(*);true;end;end;p (C.new..C.new).size')
  ).toMatchObject({ stdout: 'nil\n' });
});

test('frozen Struct assignment resolves the index before checking freeze', () => {
  expect(
    run(
      's=Struct.new(:x).new.freeze;i=Object.new;def i.to_int;puts :converted;0;end;begin;s[i]=1;rescue=>e;p e.class;end;begin;s[:missing]=1;rescue=>e;p e.class;end'
    )
  ).toMatchObject({ stdout: 'converted\nFrozenError\nNameError\n' });
});

test('beginless Range size rejects a non-discrete begin', () => {
  expect(run('begin;p (..1).size;rescue=>e;p e.class,e.message;end')).toMatchObject({
    stdout: 'TypeError\n"can\'t iterate from NilClass"\n',
  });
});

test('beginless Range count returns Infinity', () => {
  expect(run('p (..1).count,(nil..nil).count,(nil..).count')).toMatchObject({
    stdout: 'Infinity\nInfinity\nInfinity\n',
  });
});

test('defined? probes negation operands without executing them', () => {
  expect(run('p defined?(!true),defined?(not true),defined?(!missing),defined?(not missing)')).toMatchObject({
    stdout: '"method"\n"method"\nnil\nnil\n',
  });
});

test('Rational text conversion skips only Ruby numeric whitespace', () => {
  expect(run('p " 1/2".to_r;begin;p Rational(" 1/2");rescue=>e;p e.class;end')).toMatchObject({
    stdout: '(0/1)\nArgumentError\n',
  });
});

test('blockless regexp gsub! returns a mutable substitution Enumerator', () => {
  expect(run('s="abc";e=s.gsub!(/./);p e.class,e.each{|x|x.upcase},s')).toMatchObject({
    stdout: 'Enumerator\n"ABC"\n"ABC"\n',
  });
});

test('Enumerator.produce exposes infinite size', () => {
  expect(run('p Enumerator.produce(0){_1+1}.size,Enumerator.produce(0){_1+1}.lazy.take(3).size')).toMatchObject({
    stdout: 'Infinity\n3\n',
  });
});

test('Enumerator.produce passes nil to its first unseeded callback', () => {
  expect(run('f=->(x){x ? x+1 : 1};p Enumerator.produce(&f).take(3)')).toMatchObject({
    stdout: '[1, 2, 3]\n',
  });
});

test('Enumerator.new preserves the receiving subclass', () => {
  expect(run('class E<Enumerator;def twice;[self.next,self.next];end;end;p E.new{|y|y<<1<<2}.twice')).toMatchObject({
    stdout: '[1, 2]\n',
  });
});

test('Data.define preserves the receiving subclass', () => {
  expect(run('class S<Data;def greet;:ok;end;end;C=S.define(:x);p C.new(1).greet,C.superclass')).toMatchObject({
    stdout: ':ok\nS\n',
  });
});

test('Struct and Data hashes remain stable when their classes gain names', () => {
  expect(run('k=Struct.new(:x);s=k.new(1);h={s=>:hit};v=s.hash;Named=k;p [v==s.hash,h[s],k.name]')).toMatchObject({
    stdout: '[true, :hit, "Named"]\n',
  });
  expect(run('k=Data.define(:x);s=k.new(1);h={s=>:hit};v=s.hash;Named=k;p [v==s.hash,h[s],k.name]')).toMatchObject({
    stdout: '[true, :hit, "Named"]\n',
  });
});

test('keyword-init Struct classes show their mode when inspected', () => {
  expect(
    run('S=Struct.new(:a,keyword_init:true);T=Struct.new(:a,keyword_init:false);p S,S.inspect,S.to_s,T')
  ).toMatchObject({
    stdout: 'S(keyword_init: true)\n"S(keyword_init: true)"\n"S"\nT\n',
  });
});

test('defined? probes negation receiver methods and visibility', () => {
  expect(
    run(
      'def value;puts :operand;true;end;p defined?(!value);def bad;puts :raising;raise "bad";end;p defined?(!bad);class C;undef_method :!;end;p defined?(!C.new);class D;private;def !;true;end;end;p defined?(!D.new)'
    )
  ).toMatchObject({ stdout: 'operand\n"method"\nraising\nnil\nnil\nnil\n' });
});

test('defined? keeps unavailable negation operands unavailable', () => {
  expect(run('p defined?(!@unset),defined?(not @unset),defined?(!$unset)')).toMatchObject({
    stdout: 'nil\nnil\nnil\n',
  });
});

test('defined? checks call receivers before resolving their methods', () => {
  expect(run('p defined?(@x.nil?),defined?($z.to_s),defined?(@x.to_s.size);@y=1;p defined?(@y.succ)')).toMatchObject({
    stdout: 'nil\nnil\nnil\n"method"\n',
  });
});

test('defined? evaluates chained negation receivers once', () => {
  expect(run('def value;puts :value;Object.new;end;p defined?(!value.to_s)')).toMatchObject({
    stdout: 'value\n"method"\n',
  });
  expect(run('def value;puts :value;"x";end;p defined?(value.to_s.size)')).toMatchObject({
    stdout: 'value\n"method"\n',
  });
});

test('defined? suppresses Ruby errors raised by dynamic responders', () => {
  expect(run('class C;def respond_to_missing?(n,*);raise "probe";end;end;p defined?(C.new.optional)')).toMatchObject({
    stdout: 'nil\n',
  });
});

test('Struct hashing does not consume displayed object addresses', () => {
  expect(run('Struct.new(:x).new(1).hash;p Object.new')).toMatchObject({
    stdout: '#<Object:0x00007f1a2b3c0000>\n',
  });
});

test('Hash replace adopts the source identity comparison mode', () => {
  expect(
    run(
      'k="k";h={}.compare_by_identity;h.replace({k=>1});p h.compare_by_identity?,h[k],h.key?("k"),h;h["k"]=2;p h.size,h'
    )
  ).toMatchObject({ stdout: 'false\n1\ntrue\n{"k" => 1}\n1\n{"k" => 2}\n' });
});

test('regexp preprocessing bounds repeated incomplete lookbehind openers', () => {
  expect(run('begin;Regexp.new("(?<="*50000);rescue=>e;p e.class;end')).toMatchObject({
    stdout: 'RegexpError\n',
  });
});

test('regexp preprocessing bounds unmatched character classes in lookbehind', () => {
  expect(run('begin;Regexp.new("(?<="+"["*100000+")");rescue=>e;p e.class;end')).toMatchObject({ kind: 'executed' });
});

test('binary String inspect escapes valid UTF-8 byte sequences', () => {
  expect(
    run('s=String.new;s<<195<<169;p s,s.encoding;puts s.dump;u=String.new("é",encoding:Encoding::BINARY);p u')
  ).toMatchObject({
    stdout: '"\\xC3\\xA9"\n#<Encoding:BINARY (ASCII-8BIT)>\n"\\xC3\\xA9"\n"\\xC3\\xA9"\n',
  });
  expect(
    run('p String.new("日本語",encoding:"ASCII-8BIT"),128.chr,159.chr;c=String.new;c<<1<<127<<0;p c')
  ).toMatchObject({
    stdout: '"\\xE6\\x97\\xA5\\xE6\\x9C\\xAC\\xE8\\xAA\\x9E"\n"\\x80"\n"\\x9F"\n"\\x01\\x7F\\x00"\n',
  });
});

test('US-ASCII inspect and String dump use hex control escapes', () => {
  expect(run(String.raw`p 0.chr,1.chr,127.chr;puts "a\0b".dump`)).toMatchObject({
    stdout: '"\\x00"\n"\\x01"\n"\\x7F"\n"a\\x00b"\n',
  });
  expect(run(String.raw`p 5.chr.to_sym;puts ("é\x01\xff").dump`)).toMatchObject({
    stdout: ':"\\x05"\n"\\u00E9\\x01\\xFF"\n',
  });
});

test('String dump retains its supported encoding', () => {
  expect(run('p 65.chr.dump.encoding,255.chr.dump.encoding')).toMatchObject({
    stdout: '#<Encoding:US-ASCII>\n#<Encoding:BINARY (ASCII-8BIT)>\n',
  });
  expect(run('s=String.new("é",encoding:"US-ASCII");p s;puts s.dump;p s.dump.encoding')).toMatchObject({
    stdout: '"\\xC3\\xA9"\n"\\xC3\\xA9"\n#<Encoding:US-ASCII>\n',
  });
});

test('String.new recognizes supported encoding aliases', () => {
  expect(run('p String.new("x",encoding:"ASCII").encoding,String.new("x",encoding:"CP65001").encoding')).toMatchObject({
    stdout: '#<Encoding:US-ASCII>\n#<Encoding:UTF-8>\n',
  });
  expect(
    run(
      'p String.new("x",encoding:"ANSI_X3.4-1968").encoding,String.new("x",encoding:"646").encoding;begin;String.new("x",encoding:"UTF8");rescue=>e;p e.class,e.message;end'
    )
  ).toMatchObject({
    stdout: '#<Encoding:US-ASCII>\n#<Encoding:US-ASCII>\nArgumentError\n"unknown encoding name - UTF8"\n',
  });
});

test('regexp constructors reject trailing escapes', () => {
  expect(run(String.raw`begin;Regexp.new("a\\");rescue=>e;p e.class,e.message;end`)).toMatchObject({
    stdout: 'RegexpError\n"too short escape sequence: /a\\\\/"\n',
  });
});

test('Hash inspection quotes ASCII control symbol keys consistently', () => {
  expect(run(String.raw`h={:"a\x01"=>1};p h;pp h`)).toMatchObject({
    stdout: '{"a\\x01": 1}\n{"a\\x01": 1}\n',
  });
});

test('Enumerator Chain leaves external cursor methods undefined', () => {
  expect(run('c=[1].chain([2]);p c.respond_to?(:next),c.respond_to?(:peek),c.respond_to?(:feed)')).toMatchObject({
    stdout: 'false\nfalse\nfalse\n',
  });
});

test('regexp linebreak escape keeps CRLF indivisible', () => {
  expect(run(String.raw`p /\R{2}/.match?("\r\n"),/\R\n/.match?("\r\n")`)).toMatchObject({
    stdout: 'false\nfalse\n',
  });
});

test('regexp character classes keep escaped anchor letters literal', () => {
  expect(run(String.raw`p /[\A]/.match?("A"),/[\Z]/.match?("Z"),/[\R]/.match?("R")`)).toMatchObject({
    stdout: 'true\ntrue\ntrue\n',
  });
});

test('Time strftime omits padding for absent zone names', () => {
  expect(run('t=Time.at(0).getlocal("+09:00");p t.strftime("%5Z|%_5Z|%05Z|%-5Z")')).toMatchObject({
    stdout: '"|||"\n',
  });
});

test('regexp capture validation ignores comments', () => {
  expect(run('p "a".match?(Regexp.new("a # (?<foo-bar>",Regexp::EXTENDED))')).toMatchObject({ stdout: 'true\n' });
  expect(run('p "a".match?(Regexp.new("a(?#(?<foo-bar>)"))')).toMatchObject({ stdout: 'true\n' });
});

test('remove_method invalidates each successful removal before later errors', () => {
  expect(
    run(
      'class C;def a;1;end;end;begin;Object.const_get(:Missing);rescue NameError;end;C.respond_to?(:new);c=C.new;c.a;begin;C.send(:remove_method,:a,:absent);rescue NameError;begin;p c.a;rescue=>e;p e.class;end;end'
    )
  ).toMatchObject({ stdout: 'NoMethodError\n' });
});

test('visibility batches invalidate successful changes before later errors', () => {
  expect(
    run(
      'class C;def a;1;end;end;begin;Object.const_get(:Missing);rescue NameError;end;C.respond_to?(:new);c=C.new;c.a;begin;C.send(:private,:a,:absent);rescue NameError;p c.respond_to?(:a);begin;p c.a;rescue=>e;p e.class;end;end'
    )
  ).toMatchObject({ stdout: 'false\nNoMethodError\n' });
});

test('define_method keeps lifecycle methods private', () => {
  expect(
    run(
      'class C;define_method(:initialize){puts :init};end;p C.private_method_defined?(:initialize);begin;C.new.initialize;rescue=>e;p e.class;end'
    )
  ).toMatchObject({ stdout: 'true\ninit\nNoMethodError\n' });
});

test('dynamically defined singleton lifecycle methods stay public', () => {
  expect(
    run('o=Object.new;o.define_singleton_method(:initialize){:ok};p o.respond_to?(:initialize),o.initialize')
  ).toMatchObject({
    stdout: 'true\n:ok\n',
  });
});

test('inherited hooks installed from blocks run for new subclasses', () => {
  expect(
    run('class Base;define_singleton_method(:inherited){|sub|puts :child};end;Class.new(Base);class Child<Base;end')
  ).toMatchObject({ stdout: 'child\nchild\n' });
});

test('inherited hooks copied from native methods run for new subclasses', () => {
  expect(
    run('class Base;define_singleton_method(:inherited,Kernel.instance_method(:p));end;class Child<Base;end')
  ).toMatchObject({ stdout: 'Child\n' });
});

test('inherited hook dispatch reaches method_missing', () => {
  expect(
    run(
      'class Base;class<<self;undef inherited;def method_missing(n,*);puts n;end;end;end;class Child<Base;end;Class.new(Base){puts :body}'
    )
  ).toMatchObject({ stdout: 'inherited\ninherited\nbody\n' });
});

test('defined? accepts jump probes outside their execution contexts', () => {
  expect(run('p defined?(yield),defined?(redo),defined?(next),defined?(break),defined?(retry)')).toMatchObject({
    stdout: 'nil\n"expression"\n"expression"\n"expression"\n"expression"\n',
  });
});

test('Time keeps colon-qualified non-zone directives literal', () => {
  expect(run('t=Time.at(0).getlocal(0);p t.strftime("%:Z|%::Z|%:::Z")')).toMatchObject({
    stdout: '"%:Z|%::Z|%:::Z"\n',
  });
});

test('Lazy index inspection records normalized offset and method name', () => {
  expect(run('p [1].lazy.with_index,[1].lazy.each_with_index,[1].lazy.with_index(nil)')).toMatchObject({
    stdout:
      '#<Enumerator::Lazy: #<Enumerator::Lazy: [1]>:with_index(0)>\n#<Enumerator::Lazy: #<Enumerator::Lazy: [1]>:each_with_index>\n#<Enumerator::Lazy: #<Enumerator::Lazy: [1]>:with_index(0)>\n',
  });
});

test('UTC identity affects unpadded zone directives', () => {
  expect(run('p Time.utc(2024).strftime("%-z"),Time.at(0).getlocal(0).strftime("%-z")')).toMatchObject({
    stdout: '"-0000"\n"+0000"\n',
  });
});

test('Range iteration consults dynamic successor responders', () => {
  expect(
    run(
      'class C;include Comparable;attr_reader :n;def initialize(n);@n=n;end;def <=>(o);n<=>o.n;end;def respond_to_missing?(m,*);m==:succ;end;def method_missing(m,*);m==:succ ? C.new(n+1) : super;end;end;p (C.new(1)..C.new(2)).map(&:n)'
    )
  ).toMatchObject({ stdout: '[1, 2]\n' });
});

test('raise and Range step accept advertised dynamic conversions', () => {
  expect(
    run(
      'class E;def respond_to_missing?(n,*);n==:exception;end;def method_missing(n,*);n==:exception ? RuntimeError.new("dynamic") : super;end;end;begin;raise E.new;rescue=>e;p e.class,e.message;end'
    )
  ).toMatchObject({ stdout: 'RuntimeError\n"dynamic"\n' });
  expect(
    run(
      'class S;def respond_to_missing?(m,*);m==:coerce;end;def method_missing(m,x);m==:coerce ? [x,2] : super;end;end;p (1..5).step(S.new).to_a'
    )
  ).toMatchObject({ stdout: '[1, 3, 5]\n' });
});

test('raise falls back when an unadvertised exception conversion misses', () => {
  expect(
    run('class E;def method_missing(n,*);super;end;end;begin;raise E.new;rescue=>e;p e.class,e.message;end')
  ).toMatchObject({ stdout: 'TypeError\n"exception class/object expected"\n' });
});

test('Time composite and zone widths honor explicit minus flags', () => {
  expect(
    run('t=Time.utc(2024,2,29,13,5,9);p t.strftime("%-10T|%-10D|%-10R"),t.strftime("%-10z|%-10:z")')
  ).toMatchObject({ stdout: '"  13:05:09|  02/29/24|     13:05"\n"-000000000|-000000:00"\n' });
});

test('strftime v uses four-character signed years', () => {
  expect(run('p Time.utc(-1,1,1).strftime("%-20v"),Time.utc(-42,1,1).strftime("%v")')).toMatchObject({
    stdout: '"          1-JAN--001"\n" 1-JAN--042"\n',
  });
});

test('const_defined? does not fall back to Object for BasicObject classes', () => {
  expect(run('X=1;class C<BasicObject;end;p C.const_defined?(:X),C.const_defined?(:String)')).toMatchObject({
    stdout: 'false\nfalse\n',
  });
});

test('Proc parameters rejects unknown keyword options', () => {
  expect(run('begin;p proc{|x|}.parameters(lamda:true);rescue=>e;p e.class;end')).toMatchObject({
    stdout: 'ArgumentError\n',
  });
});

test('strftime composite directives and zones use Ruby space padding', () => {
  expect(run('p Time.utc(2024,2,29,13,5,9).strftime("%10T"),Time.at(0).getlocal(60).strftime("%_z")')).toMatchObject({
    stdout: '"  13:05:09"\n" +001"\n',
  });
});

test('Lazy select and reject predicates receive packed entries', () => {
  expect(run('p [nil,1,1,2].lazy.with_index.select{|x|x}.force')).toMatchObject({
    stdout: '[[nil, 0], [1, 1], [1, 2], [2, 3]]\n',
  });
  expect(run('p [nil,1].lazy.with_index.reject{|x|x.nil?}.force')).toMatchObject({
    stdout: '[[nil, 0], [1, 1]]\n',
  });
});

test('MatchData reuses frozen subject identity', () => {
  expect(
    run('s="aa".freeze;a=[];s.scan(/a/){a<<$~};p a[0].string.equal?(s),a[0].string.equal?(a[1].string)')
  ).toMatchObject({
    stdout: 'true\ntrue\n',
  });
});

test('FrozenError describes the frozen object', () => {
  expect(run('a=[1].freeze;begin;def a.foo;end;rescue=>e;p e.message;end')).toMatchObject({
    stdout: '"can\'t modify frozen Array: [1]"\n',
  });
});

test('mutable MatchData snapshots omit source instance variables', () => {
  expect(
    run(
      'class S<String;end;s=S.new("a");s.instance_variable_set(:@x,42);m=/a/.match(s);p m.string.class,m.string.instance_variables,m.string.instance_variable_get(:@x)'
    )
  ).toMatchObject({
    stdout: 'S\n[]\nnil\n',
  });
});

test('scan adopts a subject frozen by its block for later matches', () => {
  expect(run('s="aa";a=[];s.scan(/a/){a << $~.string.equal?(s);s.freeze};p a')).toMatchObject({
    stdout: '[false, true]\n',
  });
});

test('Regexp constructor rejects literal-only option letters', () => {
  expect(run('begin;Regexp.new("a","n");rescue=>e;p e.class,e.message;end')).toMatchObject({
    stdout: 'ArgumentError\n"unknown regexp option: n"\n',
  });
});

test('Rational comparison treats nil coerce as incomparable', () => {
  expect(run('class N;def coerce(x);nil;end;end;p(1r<=>N.new)')).toMatchObject({ stdout: 'nil\n' });
});

test('match snapshots have per-match String identity', () => {
  expect(
    run('a=[];"aa".scan(/a/){a<<$~};p a[0].string.equal?(a[1].string),a[0].string.equal?(a[0].string)')
  ).toMatchObject({
    stdout: 'false\ntrue\n',
  });
});

test('indirect external iterator reentrancy reports double resume', () => {
  expect(
    run('b=nil;a=Enumerator.new{|y|b.next};b=Enumerator.new{|y|a.next};begin;a.next;rescue=>e;p e.class,e.message;end')
  ).toMatchObject({
    stdout: 'FiberError\n"attempt to resume a resumed fiber (double resume)"\n',
  });
});

test('Struct and Data reject invalid first members before later conversions', () => {
  expect(
    run('o=Object.new;def o.to_str;raise "later";end;begin;Data.define(:"a=",o);rescue=>e;p e.class,e.message;end')
  ).toMatchObject({
    stdout: 'ArgumentError\n"invalid data member: a="\n',
  });
});

test('qualified Module const_get only uses Object for the first segment', () => {
  expect(
    run('module N;end;module K;end;module M;end;begin;M.const_get("K::N");rescue=>e;p e.class,e.message;end')
  ).toMatchObject({
    stdout: 'NameError\n"uninitialized constant K::N"\n',
  });
});

test('regexp split yields fields and captures to a block', () => {
  expect(run('r=[];p "aXbXc".split(/(X)/){|part|r<<part},r')).toMatchObject({
    stdout: '"aXbXc"\n["a", "X", "b", "X", "c"]\n',
  });
  expect(run('p "".split(/x/){|part|part}')).toMatchObject({ stdout: '""\n' });
});

test('escaped backslash replacements stay within the execution budget', () => {
  expect(run(String.raw`r="\\\\"*150000;p "a".sub(/a/,r).size`)).toMatchObject({ stdout: '150000\n' });
});

test('String initialization validates options before conversion and frozen reservations', () => {
  expect(
    run('s="x".freeze;begin;s.send(:initialize,capacity:1000001);rescue=>e;p e.class;end;puts :continued')
  ).toMatchObject({
    stdout: 'FrozenError\ncontinued\n',
  });
  expect(
    run(
      'c=Object.new;def c.to_int;puts :converted;1;end;begin;String.new(capacity:c,unknown:1);rescue=>e;p e.class;end'
    )
  ).toMatchObject({
    stdout: 'ArgumentError\n',
  });
  expect(
    run(
      'e=Object.new;def e.to_str;puts :encoding;"UTF-8";end;c=Object.new;def c.to_int;puts :capacity;1;end;String.new(capacity:c,encoding:e)'
    )
  ).toMatchObject({
    stdout: 'encoding\ncapacity\n',
  });
});

test('POSIX regexp classes include Unicode case, format, and private-use characters', () => {
  expect(run('p "ⅫⒶA".scan(/[[:upper:]]/),"ⅻⓐa".scan(/[[:lower:]]/)')).toMatchObject({
    stdout: '["Ⅻ", "Ⓐ", "A"]\n["ⅻ", "ⓐ", "a"]\n',
  });
  expect(run('p "👩‍💻".scan(/[[:graph:]]/).join,"👩‍💻".scan(/[[:print:]]/).join')).toMatchObject({
    stdout: '"👩‍💻"\n"👩‍💻"\n',
  });
});

test('main delegates define_method and has no protected method', () => {
  expect(run('define_method(:bar){|x=2|x};p bar;begin;protected :bar;rescue=>e;p e.class;end')).toMatchObject({
    stdout: '2\nNoMethodError\n',
  });
  expect(
    run('p respond_to?(:define_method,true),respond_to?(:using,true),respond_to?(:ruby2_keywords,true)')
  ).toMatchObject({
    stdout: 'true\ntrue\ntrue\n',
  });
});

test('alias and undef decode quoted symbol names', () => {
  expect(run('class C;def foo;1;end;alias :"bar" :"foo";undef :"foo";end;p C.new.bar')).toMatchObject({
    stdout: '1\n',
  });
});

test('external enumerators retain their own rescued exception state', () => {
  expect(
    run(
      'e=Enumerator.new{|y|begin;raise "inner";rescue;y<<$!.message;end};begin;raise "outer";rescue;p e.next;p $!.message;end'
    )
  ).toMatchObject({
    stdout: '"inner"\n"outer"\n',
  });
});

test('zero-padded floats and fractional rationals fail before execution', () => {
  expect(run('p 007.25')).toMatchObject({ kind: 'compileError' });
  expect(run('p 01e3')).toMatchObject({ kind: 'compileError' });
  expect(run('p 01.5r')).toMatchObject({ kind: 'compileError' });
});

test('lazy zip accepts dynamic public each and rejects private each', () => {
  expect(
    run(
      'class A;def respond_to_missing?(n,*)=n==:each;def method_missing(n,*);n==:each ? yield(2) : super;end;end;p [1].lazy.zip(A.new).force'
    )
  ).toMatchObject({
    stdout: '[[1, 2]]\n',
  });
  expect(
    run('class A;private;def each;yield 2;end;end;begin;p [1].lazy.zip(A.new).force;rescue=>e;p e.class;end')
  ).toMatchObject({
    stdout: 'TypeError\n',
  });
});

test('Symbol operations retain native behavior and ASCII encoding', () => {
  expect(
    run(
      'class String;def [](*);:changed;end;def start_with?(*);false;end;def match(*);:changed;end;end;p :abc[0],:abc.start_with?("a"),:abc.match(/a/)[0]'
    )
  ).toMatchObject({
    stdout: '"a"\ntrue\n"a"\n',
  });
  expect(run('p /a/.match(:abc).string.encoding,/a/.match(:abc)[0].encoding,:abc[/a/].encoding')).toMatchObject({
    stdout: '#<Encoding:US-ASCII>\n#<Encoding:US-ASCII>\n#<Encoding:US-ASCII>\n',
  });
});

test('prepend preserves direct and nested module order', () => {
  expect(
    run(
      'module A;def f;"A"+super;end;end;module B;def f;"B"+super;end;end;module C;prepend A;def f;"C"+super;end;end;class X;def f;"X";end;prepend B,C;prepend A;end;p X.ancestors.take(4),X.new.f'
    )
  ).toMatchObject({
    stdout: '[B, A, C, X]\n"BACX"\n',
  });
  expect(
    run(
      'module A;def f;"A"+super;end;end;module B;include A;def f;"B"+super;end;end;module C;def f;"C"+super;end;end;class X;def f;"X";end;prepend B,C,A;end;p X.ancestors.take(4),X.new.f'
    )
  ).toMatchObject({
    stdout: '[B, C, A, X]\n"BCAX"\n',
  });
  expect(
    run(
      'module A;def f;"A"+super;end;end;module B;prepend A;def f;"B"+super;end;end;module C;include A;def f;"C"+super;end;end;class X;def f;"X";end;prepend B,C;end;p X.ancestors.take(4),X.new.f'
    )
  ).toMatchObject({
    stdout: '[C, A, B, X]\n"CABX"\n',
  });
  expect(
    run(
      'module A;end;module B;prepend A;end;module C;include A;end;module D;end;class X;prepend B,D,C;end;p X.ancestors.take(5)'
    )
  ).toMatchObject({ stdout: '[D, C, A, B, X]\n' });
  expect(
    run(
      'module A;def f;"A"+super;end;end;module B;include A;def f;"B"+super;end;end;module D;def f;"D"+super;end;end;module C;include D;def f;"C"+super;end;end;class X;def f;"X";end;prepend B,C,A;end;p X.ancestors.take(5),X.new.f'
    )
  ).toMatchObject({ stdout: '[B, C, D, A, X]\n"BCDAX"\n' });
});

test('String rejects unknown keywords before source conversion or mutation', () => {
  expect(run('s="old";begin;s.send(:initialize,"new",bad:1);rescue ArgumentError;end;p s')).toMatchObject({
    stdout: '"old"\n',
  });
  expect(
    run('o=Object.new;def o.to_str;puts :converted;"new";end;begin;String.new(o,bad:1);rescue ArgumentError;end')
  ).toMatchObject({
    stdout: '',
  });
});

test('defined? reports writer methods and block expressions', () => {
  expect(run('a=[];p defined?(a.b=1),defined?(a[1]=1),defined?(a.each{}),defined?(proc{})')).toMatchObject({
    stdout: 'nil\n"method"\n"expression"\n"expression"\n',
  });
});

test('empty regexp classes fail before program execution', () => {
  expect(run('puts "before"; p /[]/')).toMatchObject({ kind: 'compileError' });
  expect(run('begin;Regexp.new("[]");rescue=>e;p e.class;end')).toMatchObject({ stdout: 'RegexpError\n' });
});

test('Regexp.new rejects invalid pattern encoding', () => {
  expect(run(String.raw`begin;Regexp.new("\xFF");rescue=>e;p e.class,e.message;end`)).toMatchObject({
    stdout: 'RegexpError\n"invalid multibyte character: /\\\\xFF/"\n',
  });
  expect(run('begin;Regexp.new(String.new("é",encoding:"US-ASCII"));rescue=>e;p e.class;end')).toMatchObject({
    stdout: 'RegexpError\n',
  });
  expect(run('begin;Regexp.new(String.new("é",encoding:"US-ASCII"));rescue=>e;p e.message;end')).toMatchObject({
    stdout: '"invalid multibyte character: /\\\\xC3\\\\xA9/"\n',
  });
});

test('braced Unicode regexp escapes accept codepoint lists', () => {
  expect(run(String.raw`p /\u{41 42}/.match("AB").to_a,/\u{3042 3044}/.match("あい").to_a`)).toMatchObject({
    stdout: '["AB"]\n["あい"]\n',
  });
  expect(
    run(String.raw`p /\u{41 E9}/.encoding;begin;p /\u{41 E9}/.match?("A"+233.chr);rescue=>e;p e.class;end`)
  ).toMatchObject({
    stdout: '#<Encoding:UTF-8>\nEncoding::CompatibilityError\n',
  });
  expect(run(String.raw`p "AAAA"[/[\u{41}]{2}+/]`)).toMatchObject({ stdout: '"AAAA"\n' });
});

test('Regexp case equality retains ASCII Symbol capture encoding', () => {
  expect(run('p(/a/===:abc);p $~.string.encoding,$~[0].encoding')).toMatchObject({
    stdout: 'true\n#<Encoding:US-ASCII>\n#<Encoding:US-ASCII>\n',
  });
});

test('defined? keeps compound assignment classification', () => {
  expect(run('a=[];p defined?(a[1] ||= 1),defined?(a.first += 1)')).toMatchObject({
    stdout: '"assignment"\n"assignment"\n',
  });
  expect(
    run(
      'class W; attr_writer :w; def []=(i,v); end\n private def qw=(x); end\n def t = defined?(self.qw = 1)\nend\np W.new.t'
    )
  ).toMatchObject({
    stdout: 'nil\n',
  });
});

test('lazy zip accepts BasicObject sources with public each', () => {
  expect(
    run('class A<BasicObject;def each;yield 2;end;def to_enum;[2].each;end;end;p [1].lazy.zip(A.new).force')
  ).toMatchObject({
    stdout: '[[1, 2]]\n',
  });
});

test('binary Symbol regexp subjects retain their bytes and encoding', () => {
  expect(run('s=255.chr.to_sym;p /./.match(s).string.encoding,/./.match(s)[0].bytes')).toMatchObject({
    stdout: '#<Encoding:BINARY (ASCII-8BIT)>\n[255]\n',
  });
  expect(run('begin;p /ÿ/.match?(255.chr.to_sym);rescue=>e;p e.class;end')).toMatchObject({
    stdout: 'Encoding::CompatibilityError\n',
  });
  expect(
    run(
      's=255.chr;v=:"#{s}";p v.encoding,/./.match(v).string.bytes;v=%I[#{s}][0];p v.encoding,/./.match(v).string.bytes'
    )
  ).toMatchObject({
    stdout: '#<Encoding:BINARY (ASCII-8BIT)>\n[255]\n#<Encoding:BINARY (ASCII-8BIT)>\n[255]\n',
  });
});

test('lazy zip probes private respond_to? and iterates to_enum', () => {
  expect(
    run(
      'class A;def each;yield 2;end;private;def respond_to?(n,*);n==:each || super;end;end;p [1].lazy.zip(A.new).force'
    )
  ).toMatchObject({
    stdout: '[[1, 2]]\n',
  });
  expect(run('class A;def each;yield 2;end;def to_enum;[5].each;end;end;p [1].lazy.zip(A.new).force')).toMatchObject({
    stdout: '[[1, 5]]\n',
  });
  expect(
    run(
      'class Cursor;def next;5;end;end;class A;def each;yield 2;end;def to_enum;Cursor.new;end;end;p [1,2].lazy.zip(A.new).force'
    )
  ).toMatchObject({
    stdout: '[[1, 5], [2, 5]]\n',
  });
  expect(
    run(
      'class A;def each;yield 2;end;def to_enum;puts :convert;[2].each;end;end;z=[1].lazy.zip(A.new);puts :built;p z.force'
    )
  ).toMatchObject({
    stdout: 'built\nconvert\n[[1, 2]]\n',
  });
  expect(
    run(
      'class A<BasicObject;def respond_to_missing?(n,*)=n==:each;def method_missing(n,*);n==:each ? yield(2) : super;end;def to_enum;[2].each;end;end;p [1].lazy.zip(A.new).force'
    )
  ).toMatchObject({
    stdout: '[[1, 2]]\n',
  });
  expect(
    run(
      'class A;def each;yield 2;end;def to_enum;puts :convert;[2].each;end;end;p [].lazy.zip(A.new).force;p [1].lazy.select{false}.zip(A.new).force'
    )
  ).toMatchObject({
    stdout: '[]\n[]\n',
  });
  expect(
    run(
      'class Cursor;def initialize;@n=0;end;def next;@n+=1;puts @n;raise StopIteration if @n==2;5;end;end;class A;def each;yield 2;end;def to_enum;Cursor.new;end;end;p [1,2,3].lazy.zip(A.new).force'
    )
  ).toMatchObject({
    stdout: '1\n2\n3\n[[1, 5], [2, nil], [3, 5]]\n',
  });
});

test('Float sum retains compensation across Rational values', () => {
  expect(run('p [0.5,1/3r,1/7r].sum; p [9/11r,2/5r,9/2r,6/5r].sum(0.0)')).toMatchObject({
    stdout: '0.9761904761904762\n6.918181818181818\n',
  });
  expect(run('p [3/10r,0.9,2/9r].sum; p [1/10r,1/10r,1/10r].sum(0.0);p [8/7r,3].sum(1.0)')).toMatchObject({
    stdout: '1.4222222222222223\n0.3\n5.142857142857143\n',
  });
  expect(run('p [8/7r,3].each.sum(0.0);p [1/10r,1/10r,1/10r].each.sum(0.0)')).toMatchObject({
    stdout: '4.142857142857142\n0.30000000000000004\n',
  });
});

test('Range step converts Rational values when a Float participates', () => {
  expect(run('p((1..2.5).step(1/2r).to_a);p(((1/2r)..2.5).step(1/2r).to_a)')).toMatchObject({
    stdout: '[1.0, 1.5, 2.0, 2.5]\n[0.5, 1.0, 1.5, 2.0, 2.5]\n',
  });
  expect(run('p (3r..1r).step(-1r).to_a; p (3..1/2r).step(-1).to_a; p (3r..1).step(-1).to_a')).toMatchObject({
    stdout: '[(3/1), (2/1), (1/1)]\n[3, 2, 1]\n[(3/1), (2/1), (1/1)]\n',
  });
  expect(run('t=Rational(1,10**324);p (0r..t).step(t).to_a.size')).toMatchObject({ stdout: '2\n' });
});

test('Numeric coerce accepts Rational values', () => {
  expect(run('p 1.5.coerce(1/2r),1.coerce(1/2r)')).toMatchObject({
    stdout: '[0.5, 1.5]\n[0.5, 1.0]\n',
  });
});

test('Regexp Unicode lists reject non-ASCII separators', () => {
  expect(run(String.raw`begin;Regexp.new("\\u{41 42}");rescue=>e;p e.class;end`)).toMatchObject({
    stdout: 'RegexpError\n',
  });
});

test('dynamic regexp classes can start with a closing bracket', () => {
  expect(run('p Regexp.new("[]]").match?("]"),Regexp.new("[]a]").match?("]")')).toMatchObject({
    stdout: 'true\ntrue\n',
  });
});

test('Regexp validates options before invalid pattern encoding', () => {
  expect(run(String.raw`begin;Regexp.new("\xFF","bad");rescue=>e;p e.class,e.message;end`)).toMatchObject({
    stdout: 'ArgumentError\n"unknown regexp option: bad"\n',
  });
});

test('Regexp errors render valid Unicode beside invalid bytes', () => {
  expect(run(String.raw`begin;Regexp.new("é\xFF");rescue=>e;p e.message;end`)).toMatchObject({
    stdout: '"invalid multibyte character: /\\\\u00E9\\\\xFF/"\n',
  });
});

test('Unicode regexp lists allow ASCII edge whitespace and reject surrogate values', () => {
  expect(run(String.raw`p /\u{ 41 42 }/.match("AB").to_a`)).toMatchObject({ stdout: '["AB"]\n' });
  expect(run(String.raw`p /\u{41 D800}/`)).toMatchObject({ kind: 'compileError' });
  expect(run(String.raw`begin;Regexp.new("\\u{D800}");rescue=>e;p e.class;end`)).toMatchObject({
    stdout: 'RegexpError\n',
  });
  expect(run(String.raw`p /\uD800/`)).toMatchObject({ kind: 'compileError' });
  expect(run(String.raw`begin;Regexp.new("\\uD800");rescue=>e;p e.class;end`)).toMatchObject({
    stdout: 'RegexpError\n',
  });
});

test('Regexp options precede source conversion', () => {
  expect(
    run('o=Object.new;def o.to_str;puts :source;"a";end;begin;Regexp.new(o,"bad");rescue=>e;p e.class;end')
  ).toMatchObject({
    stdout: 'ArgumentError\n',
  });
});

test('Regexp errors preserve escaped invalid source bytes', () => {
  expect(run(String.raw`begin;Regexp.new("\\\xFF");rescue=>e;p e.message.bytes.last(4);end`)).toMatchObject({
    stdout: '[47, 92, 255, 47]\n',
  });
  expect(run(String.raw`begin;Regexp.new("\\\\\xFF");rescue=>e;p e.message.bytes.last(8);end`)).toMatchObject({
    stdout: '[47, 92, 92, 92, 120, 70, 70, 47]\n',
  });
});

test('Regexp case matching rejects non-String to_str results', () => {
  expect(run('o=Object.new;def o.to_str;:abc;end;begin;p(/a/===o);rescue=>e;p e.class,e.message;end')).toMatchObject({
    stdout: 'TypeError\n"can\'t convert Object to String (Object#to_str gives Symbol)"\n',
  });
});

test('Enumerator yields without arguments become nil entries', () => {
  expect(run('e=Enumerator.new{|y|y.yield};p [e.to_a,e.first]')).toMatchObject({
    stdout: '[[nil], nil]\n',
  });
});

test('Struct bracket constructor ignores an overridden new method', () => {
  expect(run('S=Struct.new(:x);def S.new(*);:special;end;p S[1]')).toMatchObject({
    stdout: '#<struct S x=1>\n',
  });
});

test('binary Symbol case conversion keeps byte encoding', () => {
  expect(run('s=233.chr.to_sym;p [s.upcase.encoding,s.upcase.to_s.bytes,s.downcase.encoding]')).toMatchObject({
    stdout: '[#<Encoding:BINARY (ASCII-8BIT)>, [233], #<Encoding:BINARY (ASCII-8BIT)>]\n',
  });
});

test('US-ASCII Symbol interning retains invalid source bytes', () => {
  expect(
    run('s=String.new("é",encoding:"US-ASCII");q=s.to_sym;p [q.encoding,q.to_s.valid_encoding?,q.to_s.bytes,q==:é]')
  ).toMatchObject({
    stdout: '[#<Encoding:US-ASCII>, false, [195, 169], false]\n',
  });
  expect(run('s=String.new(255.chr,encoding:"US-ASCII").to_sym;p s.encoding,s.to_s.bytes')).toMatchObject({
    stdout: '#<Encoding:US-ASCII>\n[255]\n',
  });
});

test('binary Symbol inspection escapes original bytes', () => {
  expect(run('p 255.chr.to_sym,{255.chr.to_sym=>1}')).toMatchObject({
    stdout: ':"\\xFF"\n{"\\xFF": 1}\n',
  });
});

test('binary Symbol comparisons retain byte order and encoding', () => {
  expect(run('a=233.chr.to_sym;b=:é;p [a<=>b,a.casecmp(b),a.casecmp?(b)]')).toMatchObject({
    stdout: '[1, nil, nil]\n',
  });
  expect(run('p [255.chr.to_sym.casecmp(:a),255.chr.to_sym.casecmp?(:a),:a.casecmp(255.chr.to_sym)]')).toMatchObject({
    stdout: '[1, false, -1]\n',
  });
});

test('encoded Symbol inspection escapes interpolation markers', () => {
  expect(run(String.raw`s=(255.chr+%q(#{x})).to_sym;p s,{s=>1}`)).toMatchObject({
    stdout: ':"\\xFF\\#{x}"\n{"\\xFF\\#{x}": 1}\n',
  });
});

test('prepend merges shared included child chains', () => {
  expect(
    run(
      'module A;end;module B;include A;end;module C;include A;end;module D;include B,C;end;class X;prepend D;end;p X.ancestors.take(5)'
    )
  ).toMatchObject({
    stdout: '[D, B, C, A, X]\n',
  });
  expect(
    run(
      'module A;end;module B;end;module P;prepend A,B;end;module Q;include B,A;end;module R;prepend Q;end;class C;prepend P,R;end;p C.ancestors.take(6)'
    )
  ).toMatchObject({
    stdout: '[Q, B, A, P, R, C]\n',
  });
});

test('included modules share nested prepends without duplicate ancestors', () => {
  expect(
    run(
      'module Log;def run;"L"+super;end;end;module Auth;prepend Log;def run;"A"+super;end;end;class Base;def run;"B";end;end;class Svc<Base;include Auth,Log;end;p Svc.ancestors.take(4),Svc.new.run'
    )
  ).toMatchObject({
    stdout: '[Svc, Log, Auth, Base]\n"LAB"\n',
  });
  expect(
    run(
      'module Log;end;module Auth;prepend Log;end;class Base;include Log;end;class Sub<Base;include Auth;end;p Sub.ancestors.take(5)'
    )
  ).toMatchObject({
    stdout: '[Sub, Auth, Base, Log, Object]\n',
  });
  expect(
    run(
      'module Log;end;module Auth;include Log;end;class Base;end;class P1<Base;prepend Log;include Auth;end;p P1.ancestors.take(4)'
    )
  ).toMatchObject({
    stdout: '[Log, P1, Auth, Base]\n',
  });
});

test('boxed Float cannot acquire a singleton method', () => {
  expect(run('begin;Float::INFINITY.define_singleton_method(:hi){1};rescue=>e;p e.class,e.message;end')).toMatchObject({
    stdout: 'TypeError\n"can\'t define singleton"\n',
  });
});

test('binary Symbol suffix checks preserve encoding errors', () => {
  expect(run('begin;255.chr.to_sym.end_with?("é");rescue=>e;p e.class;end')).toMatchObject({
    stdout: 'Encoding::CompatibilityError\n',
  });
});

test('Struct class names honor to_str', () => {
  expect(run('x=Object.new;def x.to_str;"A";end;p Struct.new(x,:a)')).toMatchObject({ stdout: 'Struct::A\n' });
});

test('Struct and Data retain encoded member Symbol identities', () => {
  expect(
    run(
      'name=255.chr.to_sym;s=Struct.new(name);d=Data.define(name);p s.members[0].equal?(name),d.members[0].equal?(name),s.members[0].encoding'
    )
  ).toMatchObject({
    stdout: 'true\ntrue\n#<Encoding:BINARY (ASCII-8BIT)>\n',
  });
  expect(
    run('name=255.chr.to_sym;s=Struct.new(name).new(1);p s.each_pair.first[0].equal?(name),s.to_h.keys[0].equal?(name)')
  ).toMatchObject({
    stdout: 'true\ntrue\n',
  });
});

test('Struct and Data keyword initialization matches encoded members by identity', () => {
  expect(
    run(
      'a=233.chr.to_sym;b=:é;[Struct,Data].each{|k|c=k==Struct ? k.new(a,keyword_init:true) : k.define(a);begin;c.new(**{b=>1});rescue=>e;p e.class;end}'
    )
  ).toMatchObject({
    stdout: 'ArgumentError\nArgumentError\n',
  });
});

test('singleton class errors include their actual class name', () => {
  expect(
    run(
      'class Foo\n class << self\n  def build = Bar.new\n end\nend\nbegin\n Foo.build\nrescue NameError=>e\n puts e.message\nend'
    )
  ).toMatchObject({
    stdout: 'uninitialized constant #<Class:Foo>::Bar\n',
  });
  expect(
    run(
      'class Foo\n def inspect\n  puts :called\n  "I"\n end\nend\nf=Foo.new\nclass << f\n def g = Nope\nend\nbegin\n f.g\nrescue NameError=>e\n puts e.message\nend'
    )
  ).toMatchObject({
    stdout: expect.stringMatching(/^uninitialized constant #<Class:#<Foo:0x[\da-f]+>>::Nope\n$/),
  });
  expect(
    run('o=Object.new\nclass << o\n def f = Nope\nend\nbegin\n o.f\nrescue NameError=>e\n puts e.message\nend')
  ).toMatchObject({
    stdout: 'uninitialized constant Nope\n',
  });
});

test('Data keyword errors preserve encoded Symbol names', () => {
  expect(run('a=233.chr.to_sym;b=:é;begin;Data.define(a).new(**{b=>1});rescue=>e;puts e.message;end')).toMatchObject({
    stdout: 'missing keyword: :"\\xE9"\n',
  });
});

test('Struct unknown keyword errors retain encoded name bytes', () => {
  expect(
    run('a=233.chr.to_sym;begin;Struct.new(:x,keyword_init:true).new(**{a=>1});rescue=>e;p e.message.bytes.last;end')
  ).toMatchObject({
    stdout: '233\n',
  });
  expect(
    run(
      'a=233.chr.to_sym;begin;Struct.new(:x,keyword_init:true).new(**{a=>1});rescue=>e;p e.message.encoding,e.message.valid_encoding?;end'
    )
  ).toMatchObject({ stdout: '#<Encoding:BINARY (ASCII-8BIT)>\ntrue\n' });
  expect(
    run('a=233.chr.to_sym;begin;Struct.new(:x,keyword_init:true).new(**{a=>1,:é=>2});rescue=>e;p e.class,e.message;end')
  ).toMatchObject({
    stdout: 'Encoding::CompatibilityError\n"incompatible character encodings: BINARY (ASCII-8BIT) and UTF-8"\n',
  });
  expect(
    run(
      's=Struct.new(:x,keyword_init:true).new(x:1);begin;s.send(:initialize,x:2,**{:é=>1,233.chr.to_sym=>2});rescue=>e;p e.class;end;p s'
    )
  ).toMatchObject({ stdout: 'Encoding::CompatibilityError\n#<struct x=2>\n' });
  expect(
    run(
      'a=String.new(255.chr,encoding:"US-ASCII").to_sym;b=233.chr.to_sym;begin;Struct.new(:x,keyword_init:true).new(**{a=>1,b=>2});rescue=>e;p e.class,e.message;end'
    )
  ).toMatchObject({
    stdout: 'Encoding::CompatibilityError\n"incompatible character encodings: US-ASCII and BINARY (ASCII-8BIT)"\n',
  });
  expect(
    run(
      'a=String.new(255.chr,encoding:"US-ASCII").to_sym;b=233.chr.to_sym;begin;Struct.new(:x,keyword_init:true).new(**{a=>1,b=>2});rescue=>e;p e.message.encoding;end'
    )
  ).toMatchObject({ stdout: '#<Encoding:BINARY (ASCII-8BIT)>\n' });
});

test('anonymous class instances have Ruby class names in method errors', () => {
  expect(run('k=Class.new;begin;k.new.zork;rescue NoMethodError=>e;puts e.message;end')).toMatchObject({
    stdout: expect.stringMatching(/^undefined method 'zork' for an instance of #<Class:0x[\da-f]+>\n$/),
  });
});

test('Encoding names are canonical frozen US-ASCII strings', () => {
  expect(
    run('e=Encoding::UTF_8;p [e.name.frozen?,e.to_s.frozen?,e.name.equal?(e.name),e.inspect.encoding]')
  ).toMatchObject({
    stdout: '[true, true, true, #<Encoding:US-ASCII>]\n',
  });
});

test('Encoding objects reject copying with a Ruby TypeError', () => {
  expect(
    run('[:dup,:clone].each{|method|begin;Encoding::UTF_8.send(method);rescue=>e;p e.class,e.message;end}')
  ).toMatchObject({
    stdout: 'TypeError\n"allocator undefined for Encoding"\nTypeError\n"allocator undefined for Encoding"\n',
  });
});

test('named capture names retain their regexp encoding', () => {
  expect(
    run('r=/(?<word>a)/;m=r.match("a");p [r.names[0].encoding,m.names[0].encoding,m.named_captures.keys[0].encoding]')
  ).toMatchObject({
    stdout: '[#<Encoding:US-ASCII>, #<Encoding:US-ASCII>, #<Encoding:US-ASCII>]\n',
  });
  expect(run('p /(?<word>é)/.names[0].encoding')).toMatchObject({ stdout: '#<Encoding:UTF-8>\n' });
  expect(
    run(
      'r=Regexp.new("(?<"+233.chr+">a)");m=r.match("a");p r.names[0].bytes,m.names[0].bytes,m.named_captures(symbolize_names:true).keys[0].to_s.bytes'
    )
  ).toMatchObject({ stdout: '[233]\n[233]\n[233]\n' });
  expect(
    run(
      'r=Regexp.new("(?<"+233.chr+">a)");m=r.match("a");p m.deconstruct_keys(nil).keys[0].to_s.bytes,m.deconstruct_keys([:é])'
    )
  ).toMatchObject({ stdout: '[233]\n{}\n' });
  expect(
    run(
      'm=Regexp.new("(?<"+233.chr+">a)").match("a");[:é,"é",233.chr.to_sym].each{|key|begin;p m[key];rescue=>e;p e.class;end}'
    )
  ).toMatchObject({ stdout: 'IndexError\nIndexError\n"a"\n' });
});

test('encoding-neutral regexp classes use binary byte semantics on binary strings', () => {
  expect(
    run(
      String.raw`p 233.chr.match?(/[[:alpha:]]/),233.chr.match?(/[[:word:]]/),"é".match?(/[[:alpha:]]/),178.chr.match?(/[[:alnum:]]/),233.chr.match?(/[[:^alpha:]]/),(233.chr+"a").match?(/\ba/)`
    )
  ).toMatchObject({ stdout: 'false\nfalse\ntrue\nfalse\ntrue\ntrue\n' });
});

test('binary rpartition probes with the same regexp classes as the match', () => {
  expect(run('p ("a"+233.chr).rpartition(/[[:alpha:]]/).map(&:bytes)')).toMatchObject({
    stdout: '[[], [97], [233]]\n',
  });
});

test('Unicode property escapes fix regexp encoding to UTF-8', () => {
  expect(
    run(
      String.raw`p /\p{Alpha}/.encoding;begin;233.chr.match?(/\p{Alpha}/);rescue=>e;p e.class;end;p /[[:alpha:]]/.encoding`
    )
  ).toMatchObject({
    stdout: '#<Encoding:UTF-8>\nEncoding::CompatibilityError\n#<Encoding:US-ASCII>\n',
  });
});

test('POSIX brackets and literal hash keep following properties active', () => {
  expect(
    run(String.raw`r=/[[:alpha:]#\p{Digit}]/x;p r.encoding;begin;233.chr.match?(r);rescue=>e;p e.class;end`)
  ).toMatchObject({ stdout: '#<Encoding:UTF-8>\nEncoding::CompatibilityError\n' });
});

test('binary regexp property classes use ASCII membership', () => {
  expect(
    run(
      String.raw`r=Regexp.new(String.new('\p{Lower}',encoding:'ASCII-8BIT'));p r.encoding,233.chr.match?(r);r=Regexp.new(String.new('\P{Lower}',encoding:'ASCII-8BIT'));p 233.chr.match?(r)`
    )
  ).toMatchObject({ stdout: '#<Encoding:BINARY (ASCII-8BIT)>\nfalse\ntrue\n' });
});

test('binary regexp construction rejects Unicode-only property names', () => {
  expect(
    run(
      String.raw`%w[Lowercase Uppercase Punctuation Ll Lu P].each{|name|begin;Regexp.new(String.new('\p{'+name+'}',encoding:'ASCII-8BIT'));rescue=>e;p e.class;end}`
    )
  ).toMatchObject({ stdout: 'RegexpError\n'.repeat(6) });
});

test('binary regexp ASCII property matches only ASCII bytes', () => {
  expect(
    run(
      String.raw`r=Regexp.new(String.new('\p{ASCII}',encoding:'ASCII-8BIT'));s=Regexp.new(String.new('\P{ASCII}',encoding:'ASCII-8BIT'));p [r.match?('a'),r.match?(233.chr)],[s.match?('a'),s.match?(233.chr)]`
    )
  ).toMatchObject({ stdout: '[true, false]\n[false, true]\n' });
});

test('binary regexp classes retain ASCII semantics on compatible UTF-8 subjects', () => {
  expect(
    run(
      String.raw`r=Regexp.new(String.new('\P{Lower}',encoding:'ASCII-8BIT'),Regexp::IGNORECASE);p r.match?('a'),r.match?('A'),r.match?(String.new('a',encoding:'ASCII-8BIT'))`
    )
  ).toMatchObject({ stdout: 'false\nfalse\nfalse\n' });
});

test('bracketed binary negated properties retain casefold membership', () => {
  expect(
    run(
      String.raw`r=Regexp.new(String.new('[\P{Lower}]',encoding:'ASCII-8BIT'),Regexp::IGNORECASE);p r.match?('a'),r.match?('A'),r.match?(233.chr)`
    )
  ).toMatchObject({ stdout: 'true\ntrue\ntrue\n' });
  expect(
    run(
      String.raw`r=Regexp.new(String.new('[\P{Lower}]',encoding:'ASCII-8BIT'),Regexp::IGNORECASE);p [170,186,233].map{|n|r.match?(n.chr)}`
    )
  ).toMatchObject({ stdout: '[true, true, true]\n' });
});

test('binary negated POSIX classes fold their complemented byte sets', () => {
  expect(
    run(
      String.raw`r=Regexp.new(String.new('[[:^lower:]]',encoding:'ASCII-8BIT'),Regexp::IGNORECASE);p r.match?('a'),r.match?('A'),r.match?(233.chr)`
    )
  ).toMatchObject({ stdout: 'true\ntrue\ntrue\n' });
});

test('word escapes stay ASCII under Unicode case folding', () => {
  expect(run(String.raw`p "K".match?(/\w/i),"K".match?(/\W/i),"ſ".match?(/\w/i)`)).toMatchObject({
    stdout: 'false\ntrue\nfalse\n',
  });
});

test('invalid US-ASCII Symbol size counts bytes', () => {
  expect(run('s=String.new("é",encoding:"US-ASCII").to_sym;p s.size')).toMatchObject({ stdout: '2\n' });
});

test('Unicode Word classes include Alphabetic circled letters', () => {
  expect(run(String.raw`p "Ⓐ".match?(/[[:word:]]/),"ⓐ".match?(/\p{Word}/),"Ⓐ".match?(/[[:alpha:]]/)`)).toMatchObject({
    stdout: 'true\ntrue\ntrue\n',
  });
});

test('remove_method leaves undefined inherited methods hidden', () => {
  expect(
    run(
      'class A;def f;1;end;end;class B<A;undef_method :f;begin;remove_method :f;rescue=>e;p e.class,e.message;end;end;p B.new.respond_to?(:f)'
    )
  ).toMatchObject({ stdout: 'NameError\n"method \'f\' not defined in B"\nfalse\n' });
});

test('suspended enumerator inspections do not mark caller Structs recursive', () => {
  expect(
    run(
      'class X;def inspect;if !$once;$once=true;$y << :pause;end;"X";end;end;s=Struct.new(:v).new(X.new);e=Enumerator.new{|y|$y=y;p s.inspect};p e.next;p s.inspect;begin;e.next;rescue StopIteration;end'
    )
  ).toMatchObject({ stdout: ':pause\n"#<struct v=X>"\n"#<struct v=X>"\n' });
});

test('suspended enumerator comparisons and hashes keep caller Struct state independent', () => {
  expect(
    run(
      'class X;def ==(other);unless $once;$once=true;$y << :pause;end;false;end;end;S=Struct.new(:x);a=S.new(X.new);b=S.new(X.new);e=Enumerator.new{|y|$y=y;p(a==b)};p e.next;p(a==b);begin;e.next;rescue StopIteration;end'
    )
  ).toMatchObject({ stdout: ':pause\nfalse\nfalse\n' });
  expect(
    run(
      'class X;def hash;unless $once;$once=true;$y << :pause;end;3;end;end;s=Struct.new(:x).new(X.new);e=Enumerator.new{|y|$y=y;$h=s.hash};e.next;x=s.hash;begin;e.next;rescue StopIteration;end;p x==$h'
    )
  ).toMatchObject({ stdout: 'true\n' });
});

test('Enumerable enumerator sizes use a custom receiver size', () => {
  expect(
    run(
      'class C;include Enumerable;def each;yield 1;yield 2;yield 3;end;def size;3;end;end;p C.new.each_slice(2).size,C.new.map.size,C.new.each_cons(2).size'
    )
  ).toMatchObject({ stdout: '2\n3\n2\n' });
});

test('Enumerable size callbacks respect method shape and visibility', () => {
  expect(
    run('class C;include Enumerable;def each;yield 1;end;def size;puts :called;3;end;end;p C.new.find.size')
  ).toMatchObject({ stdout: 'nil\n' });
  expect(
    run(
      'class C;include Enumerable;def each;yield 1;end;end;c=C.new;def c.size;3;end;p c.map.size,c.each_slice(2).size'
    )
  ).toMatchObject({ stdout: '3\n2\n' });
  expect(
    run('class C;include Enumerable;def each;yield 1;end;private;def size;3;end;end;p C.new.map.size')
  ).toMatchObject({ stdout: '3\n' });
  expect(
    run(
      'class C;include Enumerable;def each;yield 1;end;def respond_to_missing?(n,*);n==:size || super;end;def method_missing(n,*);n==:size ? 3 : super;end;end;p C.new.map.size,C.new.each_cons(2).size'
    )
  ).toMatchObject({ stdout: '3\n2\n' });
  expect(
    run(
      'class C;include Enumerable;def each;yield 1;end;def size;3;end;def respond_to?(*a);puts :respond;false;end;end;p C.new.map.size'
    )
  ).toMatchObject({ stdout: 'respond\nnil\n' });
  expect(
    run(
      'class C<BasicObject;include ::Enumerable;def each;yield 1;end;def size;3;end;end;::Kernel.p C.new.map.size,C.new.each_slice(2).size'
    )
  ).toMatchObject({ stdout: '3\n2\n' });
  expect(
    run(
      'class C<BasicObject;include ::Enumerable;def each;yield 1;end;def method_missing(n,*a);return 3 if n==:size;super;end;end;::Kernel.p C.new.map.size,C.new.each_cons(2).size'
    )
  ).toMatchObject({ stdout: '3\n2\n' });
  expect(
    run(
      'class C<BasicObject;include ::Enumerable;def each;yield 1;end;def method_missing(n,*a);super;end;end;::Kernel.p C.new.map.size,C.new.each_cons(2).size'
    )
  ).toMatchObject({ stdout: 'nil\nnil\n' });
});

test('Enumerable window sizes use custom numeric size values', () => {
  expect(
    run(
      'class C;include Enumerable;def each;yield 1;end;def size;3.5;end;end;p C.new.each_slice(2).size,C.new.each_cons(2).size'
    )
  ).toMatchObject({ stdout: '2\n2.5\n' });
  expect(
    run(
      'class C;include Enumerable;def each;yield 1;end;def size;"3";end;end;begin;C.new.each_slice(2).size;rescue=>e;p e.class;end'
    )
  ).toMatchObject({ stdout: 'TypeError\n' });
  expect(
    run(
      'class C;include Enumerable;def each;yield 1;end;def size;3.5;end;end;p C.new.each_cons(5).size,C.new.cycle(2).size'
    )
  ).toMatchObject({
    stdout: '0\n7.0\n',
  });
});

test('Enumerator with_index converts its offset when iterated once', () => {
  expect(
    run('x=Object.new;def x.to_int;puts :convert;2;end;e=[1].each.with_index(x);puts :made;p e.to_a')
  ).toMatchObject({ stdout: 'made\nconvert\n[[1, 2]]\n' });
});

test('untransformed Lazy rewind reaches a stateful source', () => {
  expect(
    run(
      'class C;include Enumerable;def initialize;@i=0;end;def each;while @i<3;@i+=1;yield @i;end;end;def rewind;@i=0;end;end;l=C.new.lazy;p l.next;l.rewind;p l.next'
    )
  ).toMatchObject({ stdout: '1\n1\n' });
  expect(
    run(
      'class C;include Enumerable;def initialize;@i=0;end;def each(*);@i+=1;yield @i;end;def rewind;@i=0;end;end;l=C.new.lazy.each_entry(3);p l.next;l.rewind;p l.next'
    )
  ).toMatchObject({ stdout: '1\n1\n' });
});

test('Lazy each_entry forwards iteration arguments', () => {
  expect(
    run('class C;include Enumerable;def each(n=1);n.times{|i|yield i};end;end;p C.new.lazy.each_entry(3).force')
  ).toMatchObject({ stdout: '[0, 1, 2]\n' });
  expect(
    run(
      'class C;include Enumerable;def each(n=1);n.times{|i|yield i};end;def inspect;"C";end;end;p C.new.lazy.each_entry(3),C.new.lazy.each(3)'
    )
  ).toMatchObject({
    stdout: '#<Enumerator::Lazy: #<Enumerator::Lazy: C>:each_entry(3)>\n#<Enumerator::Lazy: C(3)>\n',
  });
  expect(
    run(
      'class C;include Enumerable;def each(*args);yield args;end;def inspect;"C";end;end;p C.new.lazy.each(2).each(3),C.new.lazy.each_entry(2).each(3),C.new.lazy.each(2).each_entry(3)'
    )
  ).toMatchObject({
    stdout:
      '#<Enumerator::Lazy: C(2, 3)>\n#<Enumerator::Lazy: #<Enumerator::Lazy: C>:each_entry(2, 3)>\n#<Enumerator::Lazy: #<Enumerator::Lazy: C(2)>:each_entry(3)>\n',
  });
});

test('Enumerator adapters pack zero-argument yields as nil', () => {
  expect(run('e=Enumerator.new{|y|y.yield};p e.with_index.to_a,e.with_object(:m).to_a')).toMatchObject({
    stdout: '[[nil, 0]]\n[[nil, :m]]\n',
  });
});

test('reflected variable names accept supplementary Unicode characters', () => {
  expect(
    run(
      'o=Object.new;o.instance_variable_set("@𠮷",7);p o.instance_variable_get("@𠮷");class C;end;C.class_variable_set("@@𠮷",8);p C.class_variable_get("@@𠮷")'
    )
  ).toMatchObject({ stdout: '7\n8\n' });
});

test('encoded Symbols order separately and Method hashes include their receivers', () => {
  expect(run('a="é".to_sym;b=String.new("é",encoding:"US-ASCII").to_sym;p [a==b,a<=>b,b<=>a]')).toMatchObject({
    stdout: '[false, -1, 1]\n',
  });
  expect(run('h={};1500.times{|i|h[i.to_s.to_sym.method(:to_s)]=i};p h.size')).toMatchObject({ stdout: '1500\n' });
});

test('encoded String ordering returns a normalized comparison sign', () => {
  expect(run('a=255.chr;b=String.new(a,encoding:"US-ASCII");p a<=>b,b<=>a,a.to_sym<=>b.to_sym')).toMatchObject({
    stdout: '-1\n1\n-1\n',
  });
});

test('literal MatchData inspection retains matched binary bytes', () => {
  expect(run('255.chr.sub(255.chr,"");p $~.inspect.bytes.last(3),$~.inspect.encoding')).toMatchObject({
    stdout: '[32, 255, 62]\n#<Encoding:BINARY (ASCII-8BIT)>\n',
  });
  expect(run('"a".sub("a","");p $~.inspect.encoding;65.chr.scan(65.chr);p $~.inspect.encoding')).toMatchObject({
    stdout: '#<Encoding:BINARY (ASCII-8BIT)>\n#<Encoding:BINARY (ASCII-8BIT)>\n',
  });
});

test('Lazy zip preserves callback packing for multi-yield sources', () => {
  expect(
    run(
      'e=Enumerator.new{|y|y.yield 1,2};p e.lazy.zip([3]).map(&->(pair,other){pair.sum+other}).force,e.lazy.zip([3]).flat_map{|x|x}.force'
    )
  ).toMatchObject({ stdout: '[6]\n[1, 2]\n' });
  expect(run('p [1].lazy.zip([3]).map{|x|x}.force')).toMatchObject({ stdout: '[[1, 3]]\n' });
  expect(
    run('e=Enumerator.new{|y|y.yield 1,2};e.lazy.zip([3]).each{|*args|p args};p e.lazy.zip([3]).next_values')
  ).toMatchObject({ stdout: '[[[1, 2], 3]]\n[[[1, 2], 3]]\n' });
  expect(
    run(
      'e=Enumerator.new{|y|y.yield 1,2};l=e.lazy.zip([3]).with_index;l.each{|*a|p a};p l.next_values;p [1].lazy.with_index.next_values'
    )
  ).toMatchObject({ stdout: '[[[[1, 2], 3], 0]]\n[[[[1, 2], 3], 0]]\n[[1, 0]]\n' });
});

test('define_method blocks retain lexical definition visibility', () => {
  expect(
    run(
      'class C;private;define_method(:outer){def inner;1;end};end;C.new.send(:outer);p C.private_method_defined?(:inner),C.public_method_defined?(:inner)'
    )
  ).toMatchObject({ stdout: 'true\nfalse\n' });
});

test('invalid US-ASCII strings remain distinct Hash keys from UTF-8', () => {
  expect(run('a="é";b=String.new(a,encoding:"US-ASCII");p [a==b,a.eql?(b),{a=>1}[b],{a=>1,b=>2}.size]')).toMatchObject({
    stdout: '[false, false, nil, 2]\n',
  });
});

test('anonymous instance singleton names use the anonymous class name', () => {
  expect(
    run('k=Class.new;o=k.new;class << o;def g = Nope;end;begin;o.g;rescue NameError=>e;puts e.message;end')
  ).toMatchObject({
    stdout: expect.stringMatching(/^uninitialized constant #<Class:#<#<Class:0x[\da-f]+>:0x[\da-f]+>>::Nope\n$/),
  });
});

test('Time calendar microseconds replace fractions and respect field bounds', () => {
  expect(run('p Time.utc(1970,1,1,0,0,1.5,250000).to_f,Time.utc(1970,1,1,0,0,1.5,nil).to_f')).toMatchObject({
    stdout: '1.25\n1.5\n',
  });
  expect(run('begin;Time.utc(1970,1,1,0,0,0,1000000);rescue=>e;p e.class,e.message;end')).toMatchObject({
    stdout: 'ArgumentError\n"subsecx out of range"\n',
  });
});

test('Time exact arguments accept to_int hooks', () => {
  expect(run('class Seconds;def to_int;3;end;end;v=Seconds.new;p Time.at(v).to_i,(Time.at(0)+v).to_i')).toMatchObject({
    stdout: '3\n3\n',
  });
});

test('Time exact arguments prefer fractional to_r hooks', () => {
  expect(
    run(
      'class Seconds;def to_r;Rational(1,3);end;def to_int;0;end;end;v=Seconds.new;p Time.at(v)==Time.at(Rational(1,3)),(Time.at(0)+v).to_f'
    )
  ).toMatchObject({ stdout: 'true\n0.3333333333333333\n' });
});

test('Time exact wrappers require to_int availability without probing twice', () => {
  expect(
    run('class N;def to_r;Rational(1,3);end;end;begin;p Time.at(N.new).to_f;rescue=>e;p e.class,e.message;end')
  ).toMatchObject({ stdout: 'TypeError\n"can\'t convert N into an exact number"\n' });
  expect(
    run(
      'class N;def respond_to?(n,*);return super if n!=:to_int;@n=(@n||0)+1;@n==1;end;def to_int;3;end;end;p Time.at(N.new).to_i'
    )
  ).toMatchObject({ stdout: '3\n' });
});

test('Time exact wrappers accept integer to_r results', () => {
  expect(run('class N;def to_r;2;end;def to_int;99;end;end;p (Time.at(0)+N.new).to_i')).toMatchObject({
    stdout: '2\n',
  });
});

test('Numeric Time wrappers prefer exact rational conversion to Float', () => {
  expect(
    run(
      'class N<Numeric;def to_f;puts :float;10.0;end;def to_r;puts :rational;Rational(1,3);end;def to_int;0;end;end;p Time.at(N.new)==Time.at(Rational(1,3))'
    )
  ).toMatchObject({ stdout: 'rational\ntrue\n' });
});

test('fixed format rounds Rational and Integer values exactly', () => {
  expect(
    run('p format("%.2f",Rational(1,8)),format("%.0f",Rational(5,2)),format("%.20f",Rational(1,3))')
  ).toMatchObject({
    stdout: '"0.13"\n"3"\n"0.33333333333333333333"\n',
  });
  expect(run('p format("%f",10**30)')).toMatchObject({
    stdout: '"1000000000000000000000000000000.000000"\n',
  });
});

test('exact fixed formatting omits alternate decimal point at zero precision', () => {
  expect(run('p [format("%#.0f",1),format("%#.0f",1r),format("%#.0f",1.0)]')).toMatchObject({
    stdout: '["1", "1", "1."]\n',
  });
});

test('Struct and Data reject wrong member types with Ruby wording', () => {
  expect(
    run('begin;Struct.new(:a,nil);rescue=>e;p e.message;end;begin;Data.define(1);rescue=>e;p e.message;end')
  ).toMatchObject({
    stdout: '"nil is not a symbol nor a string"\n"1 is not a symbol nor a string"\n',
  });
});

test('END registration returns nil as an expression', () => {
  expect(run('x=(END {});p x.nil?')).toMatchObject({ stdout: 'true\n' });
  expect(run('puts :before;if END {puts :after};puts :body;end')).toMatchObject({ kind: 'compileError' });
  expect(run('puts :before;p defined?(END {})')).toMatchObject({ kind: 'compileError' });
  expect(run('p defined?((END {}))')).toMatchObject({ stdout: '"expression"\n' });
  expect(run('puts :before;p(END {puts :exit})')).toMatchObject({ kind: 'compileError' });
  expect(run('puts :before;false || END {puts :exit}')).toMatchObject({ kind: 'compileError' });
  expect(run('puts :before;END {puts :exit} rescue puts(:error)')).toMatchObject({
    stdout: 'before\nexit\n',
  });
});

test('calendar microseconds parse numeric strings and to_int values', () => {
  expect(run('begin;Time.utc(2024,1,1,0,0,1.5,"Jan");rescue=>e;p e.class,e.message;end')).toMatchObject({
    stdout: 'ArgumentError\n"invalid value for Integer(): \\"Jan\\""\n',
  });
  expect(
    run('class Usec;def to_int;puts :converted;250000;end;end;p Time.utc(1970,1,1,0,0,1.5,Usec.new).to_f')
  ).toMatchObject({
    stdout: 'converted\n1.25\n',
  });
});

test('calendar microseconds preserve tiny Floats and reject non-ASCII numeric whitespace', () => {
  expect(run('p Time.utc(1970,1,1,0,0,0,1e-100).to_f')).toMatchObject({
    stdout: '1.0000000000000001e-106\n',
  });
  expect(run('Time.utc(1970,1,1,0,0,0,-1e-100)')).toMatchObject({
    uncaughtException: 'subsecx out of range (ArgumentError)',
  });
  expect(run('Time.utc(1970,1,1,0,0,0,"\u00A02")')).toMatchObject({
    uncaughtException: expect.stringContaining('invalid value for Integer()'),
  });
  expect(run('begin;Time.utc(1970,1,1,0,0,0,"1\u2028");rescue=>e;p e.message.include?(%q{\\u2028});end')).toMatchObject(
    { stdout: 'true\n' }
  );
  expect(run('begin;Time.utc(2024,1,1,0,0,0,255.chr);rescue=>e;p e.message;end')).toMatchObject({
    stdout: '"invalid value for Integer(): \\"\\\\xFF\\""\n',
  });
  expect(
    run(
      'class S<String;def inspect;puts :seen;"custom";end;end;begin;Time.utc(2024,1,1,0,0,0,S.new("bad"));rescue=>e;p e.message;end'
    )
  ).toMatchObject({ stdout: 'seen\n"invalid value for Integer(): custom"\n' });
  expect(
    run(
      'class S<String;def inspect;255.chr;end;end;begin;Time.utc(2024,1,1,0,0,0,S.new("bad"));rescue=>e;p e.message,e.message.encoding;end'
    )
  ).toMatchObject({
    stdout: '"invalid value for Integer(): \\\\xFF"\n#<Encoding:BINARY (ASCII-8BIT)>\n',
  });
  expect(
    run(
      String.raw`class S<String;def inspect;255.chr+"\n";end;end;begin;Time.utc(2024,1,1,0,0,0,S.new("bad"));rescue=>e;p e.message.bytes.last(4);end`
    )
  ).toMatchObject({ stdout: '[70, 70, 92, 110]\n' });
  expect(
    run(
      'class S<String;def inspect;255.chr+127.chr;end;end;begin;Time.utc(2024,1,1,0,0,0,S.new("bad"));rescue=>e;p e.message.bytes.last(5);end'
    )
  ).toMatchObject({ stdout: '[70, 70, 92, 99, 63]\n' });
  expect(
    run(
      'class S<String;def inspect;"é";end;end;begin;Time.utc(2024,1,1,0,0,0,S.new("bad"));rescue=>e;p e.message.encoding;end'
    )
  ).toMatchObject({ stdout: '#<Encoding:UTF-8>\n' });
});

test('defined? rejects END through statement modifiers', () => {
  for (const modifier of ['rescue nil', 'if true', 'unless false', 'while false'])
    expect(run(`puts :before;defined?(END {} ${modifier})`)).toMatchObject({ kind: 'compileError' });
  expect(run('p defined?((END {} rescue nil))')).toMatchObject({ stdout: '"expression"\n' });
});

test('frozen DATA rejects reads and cursor operations', () => {
  expect(
    run(
      'DATA.freeze;[:read,:gets,:readlines,:rewind,:eof?,:each_line].each{|m|begin;DATA.send(m){|line|line};rescue=>e;p e.class;end}\n__END__\na\n'
    )
  ).toMatchObject({
    stdout: 'FrozenError\n'.repeat(6),
  });
});

test('Method Proc calls defer keyword validation to the reflected method', () => {
  expect(run('def f(x:);x;end;begin;method(:f).to_proc.call;rescue=>e;p e.message;end')).toMatchObject({
    stdout: '"missing keyword: :x"\n',
  });
});

test('defined? classifies literal block calls before probing methods', () => {
  expect(run('p defined?([].nope {}),defined?(nope {}),defined?([].first(nope) {})')).toMatchObject({
    stdout: '"expression"\n"expression"\n"expression"\n',
  });
  expect(run('p defined?(super {})')).toMatchObject({ stdout: '"expression"\n' });
});

test('String initialization does not mutate on option conversion error', () => {
  expect(
    run(
      'e=Object.new;def e.to_str;raise "encoding";end;s="old";begin;s.send(:initialize,"new",encoding:e);rescue;end;p s'
    )
  ).toMatchObject({
    stdout: '"old"\n',
  });
  expect(
    run(
      'c=Object.new;def c.to_int;raise "capacity";end;s="old";begin;s.send(:initialize,"new",capacity:c);rescue;end;p s'
    )
  ).toMatchObject({
    stdout: '"old"\n',
  });
});

test('Regexp and Time subclasses retain constructors and native operations', () => {
  expect(
    run(`class R < Regexp
  def label; "pattern"; end
end
r = R.new("a")
p r.class, r.label, "cat".scan(r), r == /a/, r.match("a").regexp.class
p R.compile("b").class, R.new(r).class, R.union("a").class
class T < Time
  def label; year; end
end
t = T.utc(2000)
p T.new(2001).label, T.new.class, T.now.class, T.local(2002).label
p T.at(0).class, T.at(t).class, T.at(Rational(1,3)).class
p t.getutc.class, t.getlocal("+01:00").class, t.getlocal.class
p (t+1).class, (t-1).class, t.round.class, t == Time.utc(2000)
`)
  ).toMatchObject({
    kind: 'executed',
    stdout: 'R\n"pattern"\n["a"]\ntrue\nR\nR\nR\nRegexp\n2001\nT\nT\n2002\nT\nT\nT\nT\nT\nT\nTime\nTime\nTime\ntrue\n',
  });
});

test('Regexp byte escapes decode whole UTF-8 characters and retain binary bytes', () => {
  expect(
    run(String.raw`p /\xC3\xA9/.match?("é"), Regexp.new('\\xE3\\x81\\x82').match?("あ")
p "ééa".scan(/[\xC3\xA9]+/), "éé"[/\xC3\xA9{2}/]
p /\303\251/.match?("é"), /\xC3\251/.match?("é")
p /\xF0\x9F\x98\x80/.match?("😀"), /\303\251/.encoding
r=Regexp.new(String.new('\\xE9', encoding: 'ASCII-8BIT'))
p r.encoding, r.match?(233.chr)
['\\xFF', '\\xC3', '\\xC3\\x41', '\\xE0\\x80\\x80', '\\xED\\xA0\\x80'].each do |s|
  begin; Regexp.new(s); rescue => e; p e.class, e.message; end
end
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      'true\ntrue\n["éé"]\n"éé"\ntrue\ntrue\ntrue\n#<Encoding:UTF-8>\n#<Encoding:BINARY (ASCII-8BIT)>\ntrue\nRegexpError\n"invalid multibyte escape: /\\\\xFF/"\nRegexpError\n"too short escaped multibyte character: /\\\\xC3/"\nRegexpError\n"invalid multibyte escape: /\\\\xC3\\\\x41/"\nRegexpError\n"invalid multibyte escape: /\\\\xE0\\\\x80\\\\x80/"\nRegexpError\n"invalid multibyte escape: /\\\\xED\\\\xA0\\\\x80/"\n',
  });
  expect(run(String.raw`puts "before"; /\xC3/`)).toMatchObject({ kind: 'compileError' });
});

test('lazy enum_for preserves pipelines, arguments, size blocks and receiver probes', () => {
  expect(
    run(`e=Enumerator.produce(1){|x|x+1}.lazy.to_enum
p e.class,e.map{|x|x*2}.take(3).force
p [1,2,3].lazy.enum_for(:each_slice,2){|n| 12/n}.size
p [1,2,3].lazy.enum_for(:each_slice,2).map{|x|x.reverse}.force
class Bag
 include Enumerable
 def each(&b);[1,2,3].each(&b);end
 def respond_to?(name);super;end
end
p Bag.new.map.size,Bag.new.each_slice(2).size,Bag.new.each_cons(2).size
class SizedBag<Bag;def size;3;end;end
p SizedBag.new.map.size,SizedBag.new.each_slice(2).size,SizedBag.new.each_cons(2).size
`)
  ).toMatchObject({
    kind: 'executed',
    stdout: 'Enumerator::Lazy\n[2, 4, 6]\n6\n[[2, 1], [3]]\nnil\nnil\nnil\n3\n2\n2\n',
  });
});

test('dynamic Method identities, native signatures and Unicode reflection follow Ruby', () => {
  expect(
    run(`class C
 def respond_to_missing?(*);true;end
 def method_missing(n,*);n;end
end
class D<C;end
o=D.new;a=o.method(:foo);b=o.method(:foo)
p a==b,a.hash==b.hash,a==o.method(:bar),a.owner,a.call
h={a=>1};p h[b]
class D;def method_missing(*);42;end;end
p a==o.method(:foo),a.hash==o.method(:foo).hash,a.call
class A;def foo;end;end
class B<A;end
p B.new.method(:foo),method(:puts),5.method(:between?)
p "".method(:center).arity,Object.new.method(:respond_to?).arity,"".method(:upcase).parameters
m="".method(:center);p m.to_proc.arity,m.unbind.arity,m.to_proc.call(3)
p method(:Integer).arity,method(:Integer).parameters,Time.method(:at).parameters
class C;Éclair=42;Δ=1;end
p C.const_get(:Éclair),C.const_defined?(:Δ)
C.const_set(:Ⓐfoo,2);C.const_set(:"X😀",3);p C.const_get(:Ⓐfoo),C.const_get(:"X😀")
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      'true\ntrue\nfalse\nD\n:foo\n1\ntrue\ntrue\n42\n#<Method: B(A)#foo() main.rb:11>\n#<Method: Object(Kernel)#puts(*)>\n#<Method: Integer(Comparable)#between?(_, _)>\n-1\n-1\n[[:rest]]\n-1\n-1\n"   "\n-2\n[[:req, :arg], [:opt, :base], [:key, :exception]]\n[[:req, :time], [:opt, :subsec], [:opt, :unit], [:key, :in]]\n42\ntrue\n2\n3\n',
  });
});

test('Rational conversion honors hooks, exception options and fraction grammar', () => {
  expect(
    run(`p Rational("1/2",exception:false),Rational(1,2,exception:false),Rational("bad",exception:false),Rational(nil,exception:false)
class N;def to_r;Rational(1,3);end;end
class V<Numeric;def to_r;Rational(2,3);end;end
p Rational(N.new),Rational(V.new),Rational(2,N.new)
class Invalid;def to_r;1;end;end
begin;p Rational(Invalid.new);rescue=>e;p e.class,e.message;end
p Rational(Invalid.new,exception:false)
['1/-2','1/+2'].each do |s|
 begin;p Rational(s);rescue=>e;p e.class,e.message;end
 p s.to_r,Rational(s,exception:false)
end
[1,nil].each do |flag|
 begin;p Rational('bad',exception:flag);rescue=>e;p e.class,e.message;end
end
begin;p Rational(1,0,exception:false);rescue=>e;p e.class,e.message;end
begin;p Rational(1,other:true);rescue=>e;p e.class,e.message;end
class Broken;def to_r;raise 'oops';end;end
p Rational(Broken.new,exception:false)
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '(1/2)\n(1/2)\nnil\nnil\n(1/3)\n(2/3)\n(6/1)\nTypeError\n"can\'t convert Invalid to Rational (Invalid#to_r gives Integer)"\nnil\nArgumentError\n"invalid value for convert(): \\"1/-2\\""\n(1/1)\nnil\nArgumentError\n"invalid value for convert(): \\"1/+2\\""\n(1/1)\nnil\nArgumentError\n"expected true or false as exception: 1"\nArgumentError\n"expected true or false as exception: nil"\nZeroDivisionError\n"divided by 0"\nArgumentError\n"unknown keyword: :other"\nnil\n',
  });
});

test('String scan rechecks its final literal and regexp matches after mutation', () => {
  expect(
    run(`['a',/a/].each do |pattern|
 s='ab';s.scan(pattern){s[0]='c'};p s,$~
 s='ba';s.scan(pattern){s[1]='c'};p s,$~
 s='ab';s.scan(pattern){s[0]='c';s[1]='a'};p s,$&,$~.begin(0)
 s='ba';s.scan(pattern){s[0]='a';s[1]='c'};p s,$&,$~.begin(0)
end
`)
  ).toMatchObject({
    kind: 'executed',
    stdout: '"cb"\nnil\n"bc"\nnil\n"ca"\n"a"\n1\n"ac"\n"a"\n0\n"cb"\nnil\n"bc"\nnil\n"ca"\n"a"\n1\n"ac"\n"a"\n0\n',
  });
});

test('nil and Boolean singleton definitions share their class targets', () => {
  expect(
    run(`class << nil;def label;:nil_label;end;end
class << true;def label;:true_label;end;end
false.instance_eval{def label;:false_label;end}
p nil.label,true.label,false.label
nil.define_singleton_method(:other){42};p nil.other
false.instance_exec{def another;12;end};p false.another
p nil.singleton_class,true.singleton_class,false.singleton_class
def nil.direct;:direct;end;p nil.direct
begin;1.instance_eval{def nope;end};rescue=>e;p e.class,e.message;end
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      ':nil_label\n:true_label\n:false_label\n42\n12\nNilClass\nTrueClass\nFalseClass\n:direct\nTypeError\n"can\'t define singleton"\n',
  });
});

test('match result globals reject every assignment form before execution', () => {
  for (const target of ['$1', '$20', '$&', '$`', "$'", '$+']) {
    for (const assignment of [
      `${target} = 1`,
      `${target} += 1`,
      `${target} ||= 1`,
      `a, ${target} = 1, 2`,
      `for ${target} in [1];end`,
    ])
      expect(run(`puts "before";${assignment}`)).toMatchObject({ kind: 'compileError' });
  }
});

test('Regexp rejects backreferences whose captures may not participate', () => {
  for (const pattern of [
    String.raw`\A(?:(a)|b)\1\z`,
    String.raw`(a)|(b)\1`,
    String.raw`\1(a)`,
    String.raw`(?:(a))?\1`,
  ]) {
    expect(run(`p "b".match?(/${pattern}/)`)).toMatchObject({
      uncaughtException: '正規表現の省略可能なキャプチャへの後方参照は、この採点環境では使えません。',
    });
  }
  expect(run(String.raw`p "aa".match?(/(a)\1/),"aa".match?(/(a)\1|b/)`)).toMatchObject({ stdout: 'true\ntrue\n' });
});

test('Regexp construction preserves encoded patterns, initialization, BOMs and syntax diagnostics', () => {
  expect(
    run(String.raw`p Regexp.new('\\xEF\\xBB\\xBF').match?("\uFEFF"),/\xEF\xBB\xBF/.match?("\uFEFF")
p /(?<=(?:ab))c/.match?("abc"),/(?<=(?:a|b))x/.match?("bx"),/(?<=a|bc)x/.match?("bcx")
['(?<!(a))b','(?<!a(b))c','(?<=a+)b','(', '[', '*', '?', 'a{2,1}', ')', '[b-a]'].each do |s|
 begin;Regexp.new(s);rescue=>e;p e.class,e.message;end
end
class R<Regexp
 def initialize(s);puts :regexp_init;@tag=1;super(s);end
 def tag;@tag;end
end
r=R.new('a');p r.class,r.tag,r.match?('a');p R.compile('a').tag
class T<Time
 def initialize(y);puts :time_init;@tag=2;super(y);end
 def tag;@tag;end
end
t=T.new(2024);p t.class,t.tag,t.year,T.at(0).class
s=255.chr;r=Regexp.new(s)
p r.source.bytes,r.source.encoding,Regexp.new(r.source).match?(s)
p r.inspect.bytes,r.inspect.encoding,r.to_s.bytes,r.to_s.encoding
p s.match?(s),s.match(s)[0].bytes
p Regexp.escape(s).bytes,Regexp.escape(s).encoding,Regexp.union(s).match?(s)
r=/#{s}/;p r.encoding,r.match?(s)
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      'true\ntrue\ntrue\ntrue\ntrue\nRegexpError\n"invalid pattern in look-behind: /(?<!(a))b/"\nRegexpError\n"invalid pattern in look-behind: /(?<!a(b))c/"\nRegexpError\n"invalid pattern in look-behind: /(?<=a+)b/"\nRegexpError\n"end pattern with unmatched parenthesis: /(/"\nRegexpError\n"premature end of char-class: /[/"\nRegexpError\n"target of repeat operator is not specified: /*/"\nRegexpError\n"target of repeat operator is not specified: /?/"\nRegexpError\n"upper is smaller than lower in repeat range: /a{2,1}/"\nRegexpError\n"unmatched close parenthesis: /)/"\nRegexpError\n"empty range in char class: /[b-a]/"\nregexp_init\nR\n1\ntrue\nregexp_init\n1\ntime_init\nT\n2\n2024\nT\n[255]\n#<Encoding:BINARY (ASCII-8BIT)>\ntrue\n[47, 92, 120, 70, 70, 47]\n#<Encoding:BINARY (ASCII-8BIT)>\n[40, 63, 45, 109, 105, 120, 58, 255, 41]\n#<Encoding:BINARY (ASCII-8BIT)>\ntrue\n[255]\n[255]\n#<Encoding:BINARY (ASCII-8BIT)>\ntrue\n#<Encoding:BINARY (ASCII-8BIT)>\ntrue\n',
  });
});

test('Struct and Data inspection preserves member encoding and pretty layouts', () => {
  expect(
    run(String.raw`S=Struct.new(:name,:tags)
s=S.new('a'*40,(1..20).to_a)
pp s,[s,s],{s:s}
D=Data.define(:name,:tags)
pp D.new('a'*40,(1..20).to_a)
a=S.new('x',nil);a.tags=a;pp a
s=Struct.new(255.chr.to_sym).new(1)
d=Data.define(233.chr.to_sym).new(1)
p s.inspect.bytes,s.inspect.encoding,d.inspect.bytes,d.inspect.encoding
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '#<struct S\n name="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",\n tags=[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]>\n[#<struct S\n  name="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",\n  tags=\n   [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]>,\n #<struct S\n  name="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",\n  tags=\n   [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]>]\n{s:\n  #<struct S\n   name="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",\n   tags=\n    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]>}\n#<data D\n name="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",\n tags=[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]>\n#<struct S name="x", tags=#<struct S:...>>\n[35, 60, 115, 116, 114, 117, 99, 116, 32, 255, 61, 49, 62]\n#<Encoding:BINARY (ASCII-8BIT)>\n[35, 60, 100, 97, 116, 97, 32, 233, 61, 49, 62]\n#<Encoding:BINARY (ASCII-8BIT)>\n',
  });
});

test('DATA bounded reads count bytes and retain EOF behavior', () => {
  expect(
    run(String.raw`a=DATA.read(1);b=DATA.read(1)
p a.bytes,a.encoding,b.bytes,b.encoding
p DATA.read(0),DATA.read(3),DATA.read,DATA.read(1),DATA.read(0),DATA.read
__END__
éhello
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '[195]\n#<Encoding:BINARY (ASCII-8BIT)>\n[169]\n#<Encoding:BINARY (ASCII-8BIT)>\n""\n"hel"\n"lo\\n"\nnil\n""\n""\n',
  });
});

test('heredoc values work inside multiline collections and argument lists', () => {
  expect(
    run(String.raw`x=[
  1,
  <<~E
    a
  E
]
p x
config={
  name: 'x',
  text: <<~E,
    body
  E
  z:1
}
p config
puts(
  <<~E
    a
  E
)
p Struct.new(:a).new(
  <<~E
    a
  E
)
`)
  ).toMatchObject({
    kind: 'executed',
    stdout: '[1, "a\\n"]\n{name: "x", text: "body\\n", z: 1}\na\n#<struct a="a\\n">\n',
  });
});

test('static symbols reject invalid UTF-8 before executing their program', () => {
  for (const expression of [String.raw`:"\xFF"`, String.raw`{"\xFF":1}`, String.raw`case {}; in "\xFF": x;end`]) {
    expect(run(`puts :before;${expression}`)).toMatchObject({ kind: 'compileError' });
  }
  expect(run(String.raw`p :"\xC3\xA9"`)).toMatchObject({ stdout: ':é\n' });
});

test('source encoding directives explicitly reject unsupported source encodings', () => {
  for (const header of ['# coding: binary', '# encoding: Shift_JIS', '#!/usr/bin/ruby\n# coding: ASCII-8BIT']) {
    const result = run(`${header}\np __ENCODING__`);
    expect(result).toMatchObject({
      kind: 'compileError',
      diagnostics: [{ message: expect.stringContaining('ソースコードの文字コード') }],
    });
  }
  expect(run('# coding: UTF-8\np __ENCODING__')).toMatchObject({ stdout: '#<Encoding:UTF-8>\n' });
  expect(run('# ordinary comment\n# coding: binary\np __ENCODING__')).toMatchObject({ stdout: '#<Encoding:UTF-8>\n' });
});

test('Regexp collection operations and Rational keys stay within execution limits at scale', () => {
  expect(
    run(`p ("a,b;c "*6000).split(/[,; ]/).size
p ("ab "*12000).scan(/a|b/).size
p ("😀a "*2000).scan(/😀|a/).size
words=("😀a "*2000).split(/ /)
p words.size,words[100].bytes
h={};1500.times{|i|n=2*i;h[Rational(n,n+1)]=i};p h.size,h[Rational(4,6)]
`)
  ).toMatchObject({ stdout: '18000\n24000\n4000\n2000\n[240, 159, 152, 128, 97]\n1500\n1\n' });
});

test('regexp string assignment replaces selected captures and preserves match state', () => {
  expect(
    run(String.raw`s='éabc';p s.send(:[]=,/(a)(b)/,-1,'X'),s,$~.to_a
s='abc';p s.send(:[]=,/(?<x>b)/,:x,'\\1'),s,$~.to_a
[1,2,-2,'missing'].each do |group|
  begin;'b'[/((a))?b/,group]='X';rescue IndexError=>e;p e.message;end
end
begin;'b'[/z/]='X';rescue IndexError=>e;p e.message,$~;end
s=255.chr+'a';s[/a/]='b';p s.bytes,s.encoding
p 'hello'.start_with?(/he/)
begin;p 'hello'.end_with?(/lo/);rescue TypeError=>e;p e.message;end
`)
  ).toMatchObject({
    stdout:
      '"X"\n"éaXc"\n["ab", "a", "b"]\n"\\\\1"\n"a\\\\1c"\n["b", "b"]\n"regexp group 1 not matched"\n"regexp group 2 not matched"\n"regexp group 1 not matched"\n"undefined group name reference: missing"\n"regexp not matched"\nnil\n[255, 98]\n#<Encoding:BINARY (ASCII-8BIT)>\ntrue\n"no implicit conversion of Regexp into String"\n',
  });
});

test('regexp comment escapes do not participate in validation or encoding', () => {
  expect(
    run(String.raw`['(?#\400)a','(?#\777)a','(?#\303\251)a','(?#\xFF)a','(?#\u00e9)a','(?#\p{L})a','(?#\x)a'].each do |source|
  [0,Regexp::EXTENDED].each do |options|
    r=Regexp.new(source,options);p [r.match?('a'),r.encoding]
  end
end
p /(?#\777)a/.match?('a'),/[(?#)]/.match?('#'),Regexp.new('(?#é)a').encoding
p Regexp.new('a #\400',Regexp::EXTENDED).match?('a')
`)
  ).toMatchObject({ stdout: '[true, #<Encoding:US-ASCII>]\n'.repeat(14) + 'true\ntrue\n#<Encoding:UTF-8>\ntrue\n' });
});

test('lookbehind permits unequal fixed branches only at its noncapturing root', () => {
  expect(
    run(String.raw`['(?:a|bc)','x(?:a|bc)','(?:a|bc)x','(?:(?:a|bc))','(?:a|bc){1}','(?:a|bc){0}','(?:a|bc){2}','(?:(?:a|bc)x|z)','(?:a|bc)(?:d|ef)','(a|bc)','(a|b)','((?:a|bc))','(?:a{2}|b{3})','(?:a|bc)?'].each do |body|
  begin;Regexp.new('(?<='+body+')x');puts 'OK '+body;rescue RegexpError;puts 'NO '+body;end
end
p /(?<=(?:a|bc))x/.match?('bcx'),/(?<!(?:a|bc))x/.match?('x')
`)
  ).toMatchObject({
    stdout:
      'OK (?:a|bc)\nNO x(?:a|bc)\nNO (?:a|bc)x\nOK (?:(?:a|bc))\nOK (?:a|bc){1}\nNO (?:a|bc){0}\nNO (?:a|bc){2}\nNO (?:(?:a|bc)x|z)\nNO (?:a|bc)(?:d|ef)\nNO (a|bc)\nOK (a|b)\nNO ((?:a|bc))\nOK (?:a{2}|b{3})\nNO (?:a|bc)?\ntrue\ntrue\n',
  });
});

test('regexp encoding mismatches use their construction context without catching user errors', () => {
  expect(
    run(String.raw`[[255.chr,'é'],['é',255.chr],[Regexp.new(255.chr),/é/],[/é/,Regexp.new(255.chr)]].each do |args|
  begin;Regexp.union(*args);rescue ArgumentError=>e;p e.message;end
end
s=255.chr
begin;/é#{s}/;rescue RegexpError=>e;p e.message;end
begin;/#{s}é/;rescue RegexpError=>e;p e.message;end
class PatternPart
  def to_s;raise Encoding::CompatibilityError,'hook';end
end
begin;/#{PatternPart.new}/;rescue Encoding::CompatibilityError=>e;p e.message;end
begin;"é#{s}";rescue Encoding::CompatibilityError;p :string_error;end
`)
  ).toMatchObject({
    stdout:
      '"incompatible encodings: ASCII-8BIT and UTF-8"\n"incompatible encodings: UTF-8 and ASCII-8BIT"\n"incompatible encodings: ASCII-8BIT and UTF-8"\n"incompatible encodings: UTF-8 and ASCII-8BIT"\n"encoding mismatch in dynamic regexp : UTF-8 and ASCII-8BIT"\n"encoding mismatch in dynamic regexp : ASCII-8BIT and UTF-8"\n"hook"\n:string_error\n',
  });
});

test('position-based regexp loops share snapshots that survive later string mutations', () => {
  expect(
    run(String.raw`s='a1 '*12000
c=0;i=0;while s.match?(/\d/,i);c+=1;i+=3;end;p c
c=0;i=0;while (j=s.index(/\d/,i));c+=1;i=j+1;end;p c
c=0;i=0;while (m=s.match(/\d/,i));c+=1;i=m.end(0);end;p c
s=255.chr+'abc';m=s.match(/b/);s.replace('xyz');p m.string.bytes,m.string.frozen?,m.to_a
s='éabc';m=s.match(/b/);s.replace('xyz');p m.string,m.to_a
s='abc';m=s.match(/b/);s << 'd';s.reverse!;s.slice!(0);s.gsub!(/a/,'X');p m.string,m.to_a
`)
  ).toMatchObject({ stdout: '12000\n12000\n12000\n[255, 97, 98, 99]\ntrue\n["b"]\n"éabc"\n["b"]\n"abc"\n["b"]\n' });
});

test('regexp scan advances by original byte offsets after character-width mutations', () => {
  expect(
    run(String.raw`['éba','😀ba'].each do |s|
 n=0;s.scan(/a/){n+=1;s[0]= s[0]=='é' ? 'xy' : 'abcd' if n==1};p s,n,$~.begin(0)
end
s='éba';n=0;s.scan(/(?=a)/){n+=1;s[0]='xy' if n==1};p s,n,$~.begin(0)
s='xyba';n=0;s.scan(/a/){n+=1;s[0,2]='é' if n==1};p s,n,$~ && $~.begin(0)
`)
  ).toMatchObject({ kind: 'executed', stdout: '"xyba"\n1\n3\n"abcdba"\n1\n0\n"xyba"\n1\n3\n"éba"\n1\n2\n' });
});

test('regexp source assertions and invalid interpolated bytes retain Ruby behavior', () => {
  expect(
    run(String.raw`p 'a x'.scan(/(?<=\s|^)\w+/)
['(?<=^|,)x','(?<!^)x','(?<=,|$)x','(?<=\b)\w','(?<=\w\b)','(?<=^#)x','(?<=^.)x','(?<=\u{61})x'].each{|s|p Regexp.new(s).match?('ax')}
x="\xFF";begin;p /a#{x}b/;rescue=>e;p e.class,e.message;end
x=255.chr;p /a#{x}b/.match?('a'+x+'b')
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '["a", "x"]\nfalse\ntrue\nfalse\ntrue\ntrue\nfalse\ntrue\ntrue\nArgumentError\n"invalid multibyte character"\ntrue\n',
  });
});

test('Regexp constructors forward subclass keywords and blocks', () => {
  expect(
    run(String.raw`class R<Regexp
 attr_reader :tag
 def initialize(pattern,tag:,&block)
  @tag=block ? block.call(tag) : tag
  super(pattern)
 end
end
r=R.new('a',tag:21){|x|x*2};p r.tag,r.match?('a')
r=R.compile('b',tag:7);p r.tag,r.match?('b')
class S<Regexp
 attr_reader :options
 def initialize(pattern,**options);@options=options;super(pattern);end
end
p S.compile('a',tag:1).options
`)
  ).toMatchObject({ kind: 'executed', stdout: '42\ntrue\n7\ntrue\n{tag: 1}\n' });
});

test('record formatting and reflected names preserve Ruby metadata and bytes', () => {
  expect(
    run(String.raw`class A
  attr_accessor :x
end
p A.new.method(:x),A.instance_method(:x),A.new.method(:x=),A.method(:new),String.method(:name)
pp Struct.new(:x).new(1)
class P < Struct.new(:x,:y);def inspect = 'P!';end
pp P.new(1,2)
D=Data.define(:a){def inspect = 'DD'}
pp D.new(1)
s="\xFF";begin;p :"#{s}";rescue=>e;p e.class,e.message;end
module C;end
[192.chr,201.chr].each{|name|begin;p C.const_set(name,7);rescue NameError;p :invalid;end}
p C.const_defined?(:À),C.const_defined?(:É)
r=Time.utc(2024).strftime(255.chr+'%Y');p r.bytes,r.encoding
s="\xFF";begin;p({"#{s}":1});rescue=>e;p e.class,e.message;end
s=255.chr;p :"#{s}".to_s.bytes
name='A'+255.chr;p C.const_set(name,8),C.const_get(name)
pp Struct.new(nil).new,Data.define.new
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '#<Method: A#x() main.rb:2>\n#<UnboundMethod: A#x() main.rb:2>\n#<Method: A#x=(_) main.rb:2>\n#<Method: #<Class:A>(Class)#new(*)>\n#<Method: #<Class:String>(Module)#name()>\n#<struct  x=1>\n#<struct P x=1, y=2>\n#<data D a=1>\nEncodingError\n"invalid symbol in encoding UTF-8 :\\"\\\\xFF\\""\n:invalid\n:invalid\nfalse\nfalse\n[255, 50, 48, 50, 52]\n#<Encoding:BINARY (ASCII-8BIT)>\nEncodingError\n"invalid symbol in encoding UTF-8 :\\"\\\\xFF\\""\n[255]\n8\n8\n#<struct >\n#<data>\n',
  });
});

test('native Method owners preserve binding and alias identity', () => {
  expect(
    run(String.raw`p [1].method(:map),[1].method(:map).owner,5.method(:positive?),(1..3).method(:sum),'a'.method(:between?)
u=Array.instance_method(:map);p u.owner,u.bind([1,2]).call{|x|x*2},u==Enumerable.instance_method(:map)
class A<Array;alias m map;end
p A.instance_method(:m).owner,A.instance_method(:m)==Array.instance_method(:map)
a=A.new([1]);x=a.method(:m);y=Array.instance_method(:map).bind(a);p x==y,x.hash==y.hash
class B;def f;1;end;end
class C<B;alias g f;end
p C.instance_method(:g).owner,C.instance_method(:g)==B.instance_method(:f)
c=C.new;p c.method(:g)==c.method(:f),c.method(:g).hash==c.method(:f).hash
begin;u.bind(Object.new);rescue TypeError=>e;puts e.message;end
p A.instance_method(:m),a.method(:m),C.instance_method(:g),c.method(:g)
h={a:1};e=Array.instance_method(:entries).bind(h);p e.call,e==h.method(:entries),e.hash==h.method(:entries).hash
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '#<Method: Array#map()>\nArray\n#<Method: Integer(Numeric)#positive?()>\n#<Method: Range(Enumerable)#sum(*)>\n#<Method: String(Comparable)#between?(_, _)>\nArray\n[2, 4]\nfalse\nA\ntrue\ntrue\ntrue\nC\ntrue\ntrue\ntrue\nbind argument must be an instance of Array\n#<UnboundMethod: Array#m(map)()>\n#<Method: A(Array)#m(map)()>\n#<UnboundMethod: B#g(f)() main.rb:6>\n#<Method: C(B)#g(f)() main.rb:6>\n[[:a, 1]]\nfalse\ntrue\n',
  });
});

test('external and lazy enumerators honor dynamically advertised protocols', () => {
  expect(
    run(String.raw`class Size
 def respond_to_missing?(n,*)=n==:call
 def method_missing(n,*);return 7 if n==:call;super;end
 def to_int;3;end
end
e=Enumerator.new(Size.new){|y|y<<1};p e.size,e.to_a
class C
 include Enumerable
 def initialize;@i=0;end
 def each;@i+=1;yield @i;end
 def respond_to_missing?(n,*)=[:size,:rewind].include?(n)
 def method_missing(n,*);return 3 if n==:size;return @i=0 if n==:rewind;super;end
end
p C.new.lazy.size,C.new.lazy.map{|x|x}.size,C.new.lazy.take(2).size
e=C.new.to_enum;p e.next;e.rewind;p e.next
e=C.new.lazy;p e.next;e.rewind;p e.next
class Item
 def force;[];end
 def respond_to_missing?(n,*)=n==:each
 def method_missing(n,*);return yield 3 if n==:each;super;end
end
p [1].lazy.flat_map{Item.new}.force
class Item2
 def each;yield 4;end
 def respond_to_missing?(n,*)=n==:force
 def method_missing(n,*);return [] if n==:force;super;end
end
p [1].lazy.flat_map{Item2.new}.force
`)
  ).toMatchObject({ kind: 'executed', stdout: '7\n[1]\n3\n3\n2\n1\n1\n1\n1\n[3]\n[4]\n' });
});

test('regexp syntax diagnostics preserve Ruby categories before host translation', () => {
  expect(
    run(String.raw`['\x','\xZ','[\x]','\c','(?<n','[^]','(?','(?i','(?z)','(?P<a>x)','[a-\d]','[\d-a]','\u','\u12','\u{110000}'].each do |s|
 begin;Regexp.new(s);rescue RegexpError=>e;p e.message;end
end
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '"invalid hex escape: /\\\\x/"\n"invalid hex escape: /\\\\xZ/"\n"invalid hex escape: /[\\\\x]/"\n"too short control escape: /\\\\c/"\n"invalid group name <n>: /(?<n/"\n"empty char-class: /[^]/"\n"end pattern in group: /(?/"\n"end pattern in group: /(?i/"\n"undefined group option: /(?z)/"\n"undefined group option: /(?P<a>x)/"\n"char-class value at end of range: /[a-\\\\d]/"\n"unmatched range specifier in char-class: /[\\\\d-a]/"\n"too short escape sequence: /\\\\u/"\n"invalid Unicode escape: /\\\\u12/"\n"invalid Unicode range: /\\\\u{110000}/"\n',
  });
});

test('strftime retains binary, US-ASCII and invalid UTF-8 format bytes', () => {
  expect(
    run(String.raw`[255.chr+'%Y',233.chr+'%m',String.new('%Y',encoding:'US-ASCII'),"\xFF%Y",'é%Y'].each do |format|
 r=Time.utc(2024).strftime(format);p r.bytes,r.encoding
end
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '[255, 50, 48, 50, 52]\n#<Encoding:BINARY (ASCII-8BIT)>\n[233, 48, 49]\n#<Encoding:BINARY (ASCII-8BIT)>\n[50, 48, 50, 52]\n#<Encoding:US-ASCII>\n[255, 50, 48, 50, 52]\n#<Encoding:UTF-8>\n[195, 169, 50, 48, 50, 52]\n#<Encoding:UTF-8>\n',
  });
});

test('encoded reflective names dispatch independently', () => {
  expect(
    run(String.raw`b = 233.chr.to_sym
u = :é
c = Class.new do
 define_method(b) { 1 }
 define_method(u) { 2 }end
o = c.new
p o.send(b), o.send(u), o.method(b).name.to_s.bytes, o.method(u).name.to_s.bytes
s = Struct.new(b,u).new(3,4)
p s.send(b), s.send(u), s[b], s[u]
module C;É=7;À=8;end
[201.chr,192.chr,201.chr.to_sym].each {|n| [:const_get,:const_defined?].each {|m| begin;p C.send(m,n);rescue NameError;p :invalid;end}}
p o.method(b).inspect.encoding
class É;define_method(233.chr) {1};end
begin;p É.new.method(233.chr).inspect;rescue Encoding::CompatibilityError=>e;p e.class,e.message;end
`)
  ).toMatchObject({
    kind: 'executed',
    stdout: String.raw`1
2
[233]
[195, 169]
3
4
3
4
:invalid
:invalid
:invalid
:invalid
:invalid
:invalid
#<Encoding:BINARY (ASCII-8BIT)>
Encoding::CompatibilityError
"incompatible character encodings: UTF-8 and BINARY (ASCII-8BIT)"
`,
    stderr: String.raw``,
    uncaughtException: undefined,
  });
});

test('internal exception metadata stays separate from user variables and native hooks', () => {
  expect(
    run(String.raw`o=Object.new
o.instance_variable_set(:@__value,7)
p o.instance_variables, o.instance_variable_get(:@__value)
begin;o.missing(1);rescue NoMethodError=>e
 e.instance_variable_set(:@__receiver,3)
 p e.instance_variables,e.receiver==o,e.name
end
class Hook
 alias method_missing puts
 def respond_to_missing?(n,p=false); true; end
end
Hook.new.hello
p Comparable.method(:name)
module M;def self.x;end;end
p M.method(:name)
class Size
 def respond_to?(name,*);puts name;super;end
 def call;7;end
end
e=Enumerator.new(Size.new){};puts :made;p e.size,e.size
`)
  ).toMatchObject({
    kind: 'executed',
    stdout: String.raw`[:@__value]
7
[:@__receiver]
true
:missing
hello
#<Method: Module#name()>
#<Method: #<Class:M>(Module)#name()>
call
made
call
call
7
7
`,
    stderr: String.raw``,
    uncaughtException: undefined,
  });
});

test('frozen static literals share identity while interpolated strings and copies remain mutable', () => {
  expect(
    run(String.raw`# frozen_string_literal: true
p "lit".frozen?, %q(a).frozen?, %w(a b).map(&:frozen?), ?a.frozen?
p "hi".equal?("hi")
p "#{1}".frozen?
s=+"";s << "ok";p s
begin;"f" << "x";rescue FrozenError=>e;p e.class;end
`)
  ).toMatchObject({
    kind: 'executed',
    stdout: String.raw`true
true
[true, true]
true
true
false
"ok"
FrozenError
`,
    stderr: String.raw``,
    uncaughtException: undefined,
  });
});

test('regexp block operations retain byte cursors across receiver mutations', () => {
  expect(
    run(String.raw`s='a,b,c';s.split(/,/){|x|p x;s[2]='X'};p s
s='a1b2c';s.split(/(\d)/){|x|p x;s[1]='X'};p s
s='a,b,c';begin;s.split(/,/){|x|p x;s << 'x'};rescue=>e;p e.class,e.message;end
['éaa','😀aa'].each {|text| n=0;text.scan('a'){n+=1;text[0]=text.start_with?('é') ? 'xy' : 'abcd' if n==2};p text,n,$~.begin(0)}
s='éaa';n=0;p s.gsub(/a/){n+=1;s[0]='xy' if n==2;'X'};p s,$~ && $~.begin(0)
s='a';begin;s.sub!(/a/){s << 'x';'x'};rescue=>e;p e.class,e.message;end
`)
  ).toMatchObject({
    kind: 'executed',
    stdout: String.raw`"a"
"X"
"c"
"a,X,c"
"a"
"X"
"b"
"2"
"c"
"aXb2c"
"a"
RuntimeError
"string modified"
"xyaa"
2
3
"abcdaa"
2
5
"éXX"
"xyaa"
3
RuntimeError
"string modified"
`,
    stderr: String.raw``,
    uncaughtException: undefined,
  });
});

test('substitution variants preserve their own receiver mutation boundaries', () => {
  expect(
    run(String.raw`[:sub,:sub!,:gsub,:gsub!].each do |method|
 [:same,:longer,:shorter].each do |change|
  s='aba'
  begin
   result=s.send(method,/a/){s[1]='c' if change==:same;s << 'd' if change==:longer;s.slice!(1) if change==:shorter;'X'}
   p [method,change,s,result,$~ && $~.to_a]
  rescue=>e;p [method,change,s,e.class,e.message,$~ && $~.to_a];end
 end
end
s='ab';r=s.sub(/a/){s[0]='c';'X'};p s,r,$~ && $~.to_a
`)
  ).toMatchObject({
    kind: 'executed',
    stdout: String.raw`[:sub, :same, "aca", "Xba", ["a"]]
[:sub, :longer, "abad", "Xba", ["a"]]
[:sub, :shorter, "aa", "Xba", ["a"]]
[:sub!, :same, "Xca", "Xca", ["a"]]
[:sub!, :longer, "abad", RuntimeError, "string modified", ["a"]]
[:sub!, :shorter, "aa", RuntimeError, "string modified", ["a"]]
[:gsub, :same, "aca", "XcX", ["a"]]
[:gsub, :longer, "abad", RuntimeError, "string modified", ["a"]]
[:gsub, :shorter, "aa", RuntimeError, "string modified", ["a"]]
[:gsub!, :same, "XcX", "XcX", ["a"]]
[:gsub!, :longer, "abad", RuntimeError, "string modified", ["a"]]
[:gsub!, :shorter, "aa", RuntimeError, "string modified", ["a"]]
"cb"
"Xb"
["a"]
`,
    stderr: String.raw``,
    uncaughtException: undefined,
  });
});

test('regexp source validation preserves lookbehind context and alternative widths', () => {
  expect(
    run(String.raw`['(?<=(?<!\\d)\\d)\\d','(?<=b|(?<!a))x','(?<=(?<!(?<!a)))x','(?<=b|\\z)x','(?<!\\Zb)x','(?<=(?:a|bc)|d)x','(?<=b|(?:a|bc))x','(?<=(?:a|bc))x','(?<!((a)))x'].each do |s|
 begin;p [s,Regexp.new(s).match?('abx 123')];rescue RegexpError=>e;p [s,e.class,e.message];end
end
`)
  ).toMatchObject({
    kind: 'executed',
    stdout: String.raw`["(?<=(?<!\\d)\\d)\\d", true]
["(?<=b|(?<!a))x", true]
["(?<=(?<!(?<!a)))x", false]
["(?<=b|\\z)x", RegexpError, "invalid pattern in look-behind: /(?<=b|\\z)x/"]
["(?<!\\Zb)x", RegexpError, "invalid pattern in look-behind: /(?<!\\Zb)x/"]
["(?<=(?:a|bc)|d)x", RegexpError, "invalid pattern in look-behind: /(?<=(?:a|bc)|d)x/"]
["(?<=b|(?:a|bc))x", RegexpError, "invalid pattern in look-behind: /(?<=b|(?:a|bc))x/"]
["(?<=(?:a|bc))x", false]
["(?<!((a)))x", RegexpError, "invalid pattern in look-behind: /(?<!((a)))x/"]
`,
    stderr: String.raw``,
    uncaughtException: undefined,
  });
});

test('regexp classes and constructor diagnostics preserve Ruby options and encoding', () => {
  expect(
    run(String.raw`['[\\w-z]','[\\s-z]','[\\h-z]','[a-[:alpha:]]','(?#x','\\p{','\\p{^}','\\P{Alpha','[[:alpha:]','\\u{1 2','\\u{}','a('].each do |source|
 begin;p Regexp.new(source,Regexp::IGNORECASE);rescue RegexpError=>e;p e.message;end
end
p 'foo.bar@example.com'.match?(/\A[\w+\-.]+@[a-z\d\-]+(\.[a-z\d\-]+)*\.[a-z]+\z/i)
p "ſKk_a!".scan(/[\w]/i), "ſKk_a!".scan(/[\W]/i), "ſKk_a!".scan(/[^\w]/i)
y="\xFF"; [ [y],['é',y],[y,'é'],['a',y] ].each {|args|begin;Regexp.union(*args);rescue RegexpError=>e;p e.class,e.message;end}
begin;Regexp.new('a',foo: 1);rescue ArgumentError=>e;p e.message;end
p Regexp.new('a','i',timeout:nil)
`)
  ).toMatchObject({
    kind: 'executed',
    stdout: String.raw`"unmatched range specifier in char-class: /[\\w-z]/i"
"unmatched range specifier in char-class: /[\\s-z]/i"
"unmatched range specifier in char-class: /[\\h-z]/i"
"char-class value at end of range: /[a-[:alpha:]]/i"
"end pattern in group: /(?#x/i"
"invalid character property name {}: /\\p{/i"
"invalid character property name {}: /\\p{^}/i"
"invalid character property name {Alph}: /\\P{Alpha/i"
"premature end of char-class: /[[:alpha:]/i"
"invalid Unicode list: /\\u{1 2/i"
"invalid Unicode list: /\\u{}/i"
"end pattern with unmatched parenthesis: /a(/i"
true
["k", "_", "a"]
["ſ", "K", "!"]
["ſ", "K", "!"]
RegexpError
"invalid multibyte character: /\\xFF/"
RegexpError
"invalid multibyte character: /\\u00E9|\\xFF/"
RegexpError
"invalid multibyte character: /\\xFF|\\u00E9/"
RegexpError
"invalid multibyte character: /a|\\xFF/"
"unknown keyword: :foo"
/a/i
`,
    stderr: String.raw``,
    uncaughtException: undefined,
  });
});

test('reflective constructors preserve conversion protocols, pattern encoding and diagnostics', () => {
  expect(
    run(String.raw`p (__FILE__ == $0), (__FILE__ == $PROGRAM_NAME), defined?($0)
class Parts
 def to_ary;[:foo];end
end
p Regexp.union(Parts.new).match?('food'),Regexp.union([:foo]).match?('foo')
class EmptyParts
 def to_ary;nil;end
 def to_str;'a.b';end
end
p Regexp.union(EmptyParts.new).match?('a.b')
class WrongParts
 def to_ary;1;end
end
begin;Regexp.union(WrongParts.new);rescue=>e;p e.class,e.message;end
[233,255].each {|n|s=n.chr;s.scan(s);p $~.regexp.source.bytes,$~.regexp.encoding,$~.regexp.match?(s);s.gsub(s,'x');p $~.regexp.match?(s)}
Struct.new('Replaced',:a)
Struct.new('Replaced',:b)
p Struct::Replaced.members
module Names
 [:alias_method,:undef_method,:instance_method].each do |method|
  begin;method==:alias_method ? send(method,:new_name,:missing) : send(method,:missing);rescue NameError=>e;p e.message;end
 end
end
`)
  ).toMatchObject({
    kind: 'executed',
    stdout: String.raw`true
true
"global-variable"
true
true
true
TypeError
"can't convert WrongParts to Array (WrongParts#to_ary gives Integer)"
[233]
#<Encoding:BINARY (ASCII-8BIT)>
true
true
[255]
#<Encoding:BINARY (ASCII-8BIT)>
true
true
[:b]
"undefined method 'missing' for module 'Names'"
"undefined method 'missing' for module 'Names'"
"undefined method 'missing' for module 'Names'"
`,
    stderr: String.raw`main.rb:17: warning: redefining constant Struct::Replaced
`,
    uncaughtException: undefined,
  });
});

test('regexp split limit and empty captures retain callback boundaries', () => {
  expect(
    run(String.raw`[0,1,2,-1].each {|limit|s='a,b,c';begin;r=s.split(/,/,limit){|x|p [limit,x];s << 'x'};p r;rescue=>e;p [limit,e.class,e.message];end}
['a,,','a,,b','a1b2','a12',''].each {|s|p [s,s.split(/(\d?)/),s.split(/(,?)/)]}
`)
  ).toMatchObject({
    kind: 'executed',
    stdout: String.raw`[0, "a"]
[0, RuntimeError, "string modified"]
[1, "a,b,c"]
"a,b,cx"
[2, "a"]
[2, RuntimeError, "string modified"]
[-1, "a"]
[-1, RuntimeError, "string modified"]
["a,,", ["a", "", ",", "", ","], ["a", ",", "", ","]]
["a,,b", ["a", "", ",", "", ",", "", "b"], ["a", ",", "", ",", "b"]]
["a1b2", ["a", "1", "b", "2"], ["a", "", "1", "", "b", "", "2"]]
["a12", ["a", "1", "", "2"], ["a", "", "1", "", "2"]]
["", [], []]
`,
    stderr: String.raw``,
    uncaughtException: undefined,
  });
});

test.each([
  '__FILE__ = 1',
  '__LINE__ += 1',
  '__ENCODING__ ||= 1',
  'def f(__FILE__);end',
  '->(__LINE__) {}',
  '1.times {|__ENCODING__| }',
])('reserved pseudo-variable bindings reject before any execution: %s', (source) => {
  expect(run(`puts "started"; ${source}`)).toMatchObject({ kind: 'compileError' });
});

test.each([
  '# comment; frozen_string_literal: true',
  '# frozen_string_literal: true; ordinary comment',
  '# note: frozen_string_literal: true',
])('ordinary header comments leave literals mutable: %s', (header) => {
  expect(run(`${header}\ns = "a"; s << "b"; p s`)).toMatchObject({
    kind: 'executed',
    stdout: '"ab"\n',
    uncaughtException: undefined,
  });
});

test.each([
  '# coding: UTF-8-unix',
  '# coding: UTF-8-dos',
  '# coding: UTF-8-mac',
  '# coding: CP65001',
  '# vim: fileencoding=UTF-8',
])('UTF-8 source aliases retain multibyte literal semantics: %s', (header) => {
  expect(run(`${header}\np "é".bytes`)).toMatchObject({
    kind: 'executed',
    stdout: '[195, 169]\n',
    uncaughtException: undefined,
  });
});

test('later valid frozen-string directives override earlier headers', () => {
  expect(run('# frozen_string_literal: true\n# frozen_string_literal: false\ns="a"; s << "b"; p s')).toMatchObject({
    kind: 'executed',
    stdout: '"ab"\n',
    uncaughtException: undefined,
  });
});

test('interpolation preserves encoded symbols and distinct reflective identifiers', () => {
  expect(
    run(String.raw`s=String.new(255.chr,encoding:'US-ASCII')
p :"#{s}".encoding,:"#{s}".to_s.bytes,{"#{s}": 1}.keys.first.encoding
p :"#{s}" == 255.chr.to_sym
["#{s}","x#{s}","#{s}x", "#{s}#{'a'}", "#{'a'}#{s}"].each {|v|p v.encoding,v.bytes}
['UTF-8','US-ASCII','BINARY'].each {|encoding|['','a'].each {|text|v=String.new(text,encoding:encoding);p [encoding,text,"#{v}".encoding,"#{v}x".encoding,"x#{v}".encoding]}}
b=:"#{s}";c=Class.new {define_method(b){1};define_method(255.chr.to_sym){2}};o=c.new;p o.send(b),o.send(255.chr.to_sym),o.method(b).name.encoding
p o.method(b).inspect.encoding
begin;c.define_method(s){3};rescue EncodingError=>error;p error.class,error.message;end
begin;o.send(:"#{s}missing");rescue EncodingError=>error;p error.class,error.message;end
[255.chr.to_sym,b].each {|name|begin;Object.new.send(name);rescue NoMethodError=>error;p error.message,error.message.encoding;end}
`)
  ).toMatchObject({
    kind: 'executed',
    stdout: String.raw`#<Encoding:US-ASCII>
[255]
#<Encoding:US-ASCII>
false
#<Encoding:US-ASCII>
[255]
#<Encoding:US-ASCII>
[120, 255]
#<Encoding:UTF-8>
[255, 120]
#<Encoding:UTF-8>
[255, 97]
#<Encoding:US-ASCII>
[97, 255]
["UTF-8", "", #<Encoding:UTF-8>, #<Encoding:UTF-8>, #<Encoding:UTF-8>]
["UTF-8", "a", #<Encoding:UTF-8>, #<Encoding:UTF-8>, #<Encoding:UTF-8>]
["US-ASCII", "", #<Encoding:UTF-8>, #<Encoding:UTF-8>, #<Encoding:UTF-8>]
["US-ASCII", "a", #<Encoding:UTF-8>, #<Encoding:UTF-8>, #<Encoding:UTF-8>]
["BINARY", "", #<Encoding:UTF-8>, #<Encoding:BINARY (ASCII-8BIT)>, #<Encoding:UTF-8>]
["BINARY", "a", #<Encoding:UTF-8>, #<Encoding:BINARY (ASCII-8BIT)>, #<Encoding:UTF-8>]
1
2
#<Encoding:US-ASCII>
#<Encoding:US-ASCII>
EncodingError
"invalid symbol in encoding US-ASCII :\"\\xFF\""
EncodingError
"invalid symbol in encoding UTF-8 :\"\\xFFmissing\""
"undefined method '\xFF' for an instance of Object"
#<Encoding:BINARY (ASCII-8BIT)>
"undefined method '\xFF' for an instance of Object"
#<Encoding:US-ASCII>
`,
    stderr: String.raw``,
    uncaughtException: undefined,
  });
});

test('byte cursors retain matches inside moved UTF-8 characters', () => {
  expect(
    run(String.raw`['é','あ','😀'].each do |character|
 [/(?=.)/,/(?:)/,/(.)/].each do |regexp|
  s='a'+character;n=0;p [character,regexp]
  s.scan(regexp) do |value|
   m=$~
   p [m.offset(0),m.to_a.map{|x|x.bytes},m.pre_match.bytes,m.post_match.bytes,m==m.dup,m.hash==m.dup.hash]
   n+=1;s[0,2]=character+'a' if n==1
  end
  p n,$~ && $~.offset(0)
 end
 s='a'+character;n=0
 result=s.gsub(/(?=.)/){n+=1;s[0,2]=character+'a' if n==1;'X'}
 p [result.bytes,n,$~.offset(0),$~.pre_match.bytes]
end
`)
  ).toMatchObject({
    kind: 'executed',
    stdout: String.raw`["é", /(?=.)/]
[[0, 0], [[]], [], [97, 195, 169], true, true]
[[1, 1], [[]], [195], [169, 97], true, true]
[[1, 1], [[]], [195, 169], [97], true, true]
3
[1, 1]
["é", /(?:)/]
[[0, 0], [[]], [], [97, 195, 169], true, true]
[[1, 1], [[]], [195], [169, 97], true, true]
[[1, 1], [[]], [195, 169], [97], true, true]
[[2, 2], [[]], [195, 169, 97], [], true, true]
4
[2, 2]
["é", /(.)/]
[[0, 1], [[97], [97]], [], [195, 169], true, true]
[[1, 2], [[169], [169]], [195], [97], true, true]
[[1, 2], [[97], [97]], [195, 169], [], true, true]
3
[1, 2]
[[88, 195, 169, 88, 97], 2, [1, 1], [195, 169]]
["あ", /(?=.)/]
[[0, 0], [[]], [], [97, 227, 129, 130], true, true]
[[1, 1], [[]], [227], [129, 130, 97], true, true]
[[2, 2], [[]], [227, 129], [130, 97], true, true]
[[1, 1], [[]], [227, 129, 130], [97], true, true]
4
[1, 1]
["あ", /(?:)/]
[[0, 0], [[]], [], [97, 227, 129, 130], true, true]
[[1, 1], [[]], [227], [129, 130, 97], true, true]
[[2, 2], [[]], [227, 129], [130, 97], true, true]
[[1, 1], [[]], [227, 129, 130], [97], true, true]
[[2, 2], [[]], [227, 129, 130, 97], [], true, true]
5
[2, 2]
["あ", /(.)/]
[[0, 1], [[97], [97]], [], [227, 129, 130], true, true]
[[1, 2], [[129], [129]], [227], [130, 97], true, true]
[[2, 3], [[130], [130]], [227, 129], [97], true, true]
[[1, 2], [[97], [97]], [227, 129, 130], [], true, true]
4
[1, 2]
[[88, 227, 129, 130, 88, 97], 2, [1, 1], [227, 129, 130]]
["😀", /(?=.)/]
[[0, 0], [[]], [], [97, 240, 159, 152, 128], true, true]
[[1, 1], [[]], [240], [159, 152, 128, 97], true, true]
[[2, 2], [[]], [240, 159], [152, 128, 97], true, true]
[[3, 3], [[]], [240, 159, 152], [128, 97], true, true]
[[1, 1], [[]], [240, 159, 152, 128], [97], true, true]
5
[1, 1]
["😀", /(?:)/]
[[0, 0], [[]], [], [97, 240, 159, 152, 128], true, true]
[[1, 1], [[]], [240], [159, 152, 128, 97], true, true]
[[2, 2], [[]], [240, 159], [152, 128, 97], true, true]
[[3, 3], [[]], [240, 159, 152], [128, 97], true, true]
[[1, 1], [[]], [240, 159, 152, 128], [97], true, true]
[[2, 2], [[]], [240, 159, 152, 128, 97], [], true, true]
6
[2, 2]
["😀", /(.)/]
[[0, 1], [[97], [97]], [], [240, 159, 152, 128], true, true]
[[1, 2], [[159], [159]], [240], [152, 128, 97], true, true]
[[2, 3], [[152], [152]], [240, 159], [128, 97], true, true]
[[3, 4], [[128], [128]], [240, 159, 152], [97], true, true]
[[1, 2], [[97], [97]], [240, 159, 152, 128], [], true, true]
5
[1, 2]
[[88, 240, 159, 152, 128, 88, 97], 2, [1, 1], [240, 159, 152, 128]]
`,
    stderr: String.raw``,
    uncaughtException: undefined,
  });
});

test.each([String.raw`/\b/`, String.raw`/\p{L}/`])(
  'context-dependent interior-byte matches fail explicitly: %s',
  (pattern) => {
    const result = run(`s="aé";n=0;s.scan(${pattern}){n+=1;s[0,2]="éa" if n==1};p n`);
    expect(result).toMatchObject({
      kind: 'executed',
      uncaughtException: 'UTF-8 の文字途中からの文脈依存の正規表現検索は、この採点環境では使えません。',
    });
  }
);

test('Enumerator initialization, module mutation and encoded dispatch preserve protocols', () => {
  expect(
    run(String.raw`class E < Enumerator
 def initialize(value:, &block)
  puts :init
  super(2){|y|y << value; y << block.call(value)}
 end
end
e=E.new(value:7){|x|x+1};p e.class,e.size,e.next,e.next
reset=Enumerator.new{|y|y << :old};reset.send(:initialize,1){|y|y << :reset};p reset.size,reset.next
class Blank < Enumerator
 def initialize; @x=1;end
end
begin;Blank.new.next;rescue=>e;p e.class,e.message;end
module Plain;end
p Plain.method(:name).to_s
module Written;@x=1;end
p Written.method(:name).to_s
module Functions;module_function;def f;7;end;end
p Functions.f,Functions.method(:name).to_s
module WrittenLater;end
WrittenLater.instance_variable_set(:@x,1);p WrittenLater.method(:name).to_s
n=("x"+255.chr).to_sym
c=Class.new{define_method(n){42}}
p n.to_proc.call(c.new),[c.new].map(&n)
s=String.new('abc',encoding:Encoding::ASCII.name)
p s.encoding==Encoding::ANSI_X3_4_1968, String.new('é',encoding:Encoding::CP65001.name).length
p defined?(DATA)
begin;DATA;rescue NameError=>e;p e.class,e.message;end
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      'init\nE\n2\n7\n8\n1\n:reset\nArgumentError\n"uninitialized enumerator"\n"#<Method: Module#name()>"\n"#<Method: #<Class:Written>(Module)#name()>"\n7\n"#<Method: #<Class:Functions>(Module)#name()>"\n"#<Method: #<Class:WrittenLater>(Module)#name()>"\n42\n[42]\ntrue\n1\nnil\nNameError\n"uninitialized constant DATA"\n',
  });
});

test('Copied methods preserve definition identity and native reflection contracts', () => {
  expect(
    run(String.raw`class A
 def f;1;end
 alias_method :alias_f,:f
end
class B<A
 define_method(:g,A.instance_method(:f))
 define_method(:h,A.instance_method(:f))
end
b=B.new
p b.method(:f)==b.method(:g),b.method(:g)==b.method(:h),b.method(:f)==b.method(:alias_f)
class C
 define_method(:convert,Kernel.instance_method(:Integer))
end
m=C.new.method(:convert);p m.call('12'),m.arity,m.parameters,m.to_proc.arity,C.instance_method(:convert).parameters
class Signatures
 def a(*);end
 def b(**nil);end
 def c(*,**,&);end
 def d(x,*,y,**,&);end
 def e(**,&);end
 def f((a,b));end
end
[:a,:b,:c,:d,:e,:f].each{|n|p Signatures.instance_method(n).to_s.sub(/ (main\.rb|-e):\d+>/,'>')}
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      'false\ntrue\ntrue\n12\n-2\n[[:req, :arg], [:opt, :base], [:key, :exception]]\n-2\n[[:req, :arg], [:opt, :base], [:key, :exception]]\n"#<UnboundMethod: Signatures#a(*)>"\n"#<UnboundMethod: Signatures#b(**nil)>"\n"#<UnboundMethod: Signatures#c(...)>"\n"#<UnboundMethod: Signatures#d(x, *, y, ...)>"\n"#<UnboundMethod: Signatures#e(**, ...)>"\n"#<UnboundMethod: Signatures#f(_)>"\n',
  });
});

test('Regexp flags, keyword validation and bounded reverse searches preserve Ruby behavior', () => {
  expect(
    run(String.raw`[Regexp.new('a',16),Regexp.new(String.new('a',encoding:'ASCII-8BIT'),16),/é/,/\p{L}/].each do |r|
 p r.options,r.encoding,r.match?('a')
 begin;p r.match?(233.chr);rescue=>e;p e.class;end
 p Regexp.new(r).options
end
begin;Regexp.union(Regexp.new('a',16),Regexp.new(String.new('b',encoding:'ASCII-8BIT'),16));rescue=>e;p e.class;end
p Regexp.union(Regexp.new('a',16),/c/).options
[proc{Regexp.new('a',foo:1,bar:2)},proc{Regexp.compile(/a/,foo:1,bar:2)},proc{Struct.new(:x,foo:1,bar:2)},proc{proc{}.parameters(foo:1,bar:2)},proc{/a/.match('a').named_captures(foo:1,bar:2)}].each do |call|
 begin;call.call;rescue=>e;p e.class,e.message;end
end
p ('b'*20000).rindex(/a/),('b'*20000).rindex(/[ac]/),('b'*20000).rpartition(/[ac]/).map(&:length)
p 'ababa'.rindex(/aba/,2),'ababa'.rpartition(/aba/),'ababa'.rindex(/a.*a/,2)
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '16\n#<Encoding:UTF-8>\ntrue\nEncoding::CompatibilityError\n16\n16\n#<Encoding:BINARY (ASCII-8BIT)>\ntrue\nfalse\n16\n16\n#<Encoding:UTF-8>\nfalse\nEncoding::CompatibilityError\n16\n16\n#<Encoding:UTF-8>\ntrue\nEncoding::CompatibilityError\n16\nArgumentError\n0\nArgumentError\n"unknown keywords: :foo, :bar"\nArgumentError\n"unknown keywords: :foo, :bar"\nArgumentError\n"unknown keywords: :foo, :bar"\nArgumentError\n"unknown keywords: :foo, :bar"\nArgumentError\n"unknown keywords: :foo, :bar"\nnil\nnil\n[0, 0, 20000]\n2\n["ab", "aba", ""]\n2\n',
  });
});

test('Regexp literal validation sees the full source and Onigmo lookbehind widths', () => {
  for (const source of [
    String.raw`/\X(/`,
    String.raw`/\G[/`,
    String.raw`/\X\1/`,
    String.raw`/(?<=\R{0})x/`,
    String.raw`/(?<=(?i:a|bc))X/`,
  ]) {
    expect(run(`puts :before; p ${source}`)).toMatchObject({ kind: 'compileError' });
  }
  expect(
    run(String.raw`p /(?<=(?:a|bc){1})X/.match?('bcX'), /\303\251/.match?('é'), /\xC3\251/.match?('é')`)
  ).toMatchObject({ stdout: 'true\ntrue\ntrue\n' });
});

test('Time float conversion preserves nanosecond arithmetic across epoch scales', () => {
  expect(
    run(`[0, 1, -1, 1709960707, -1709960707].each do |sec|
  [Rational(1,4), Rational(3,5), Rational(1,1000000000)].each {|part| p (Time.at(sec)+part).to_f}
end`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '0.25\n0.6\n1.0e-09\n1.25\n1.6\n1.000000001\n-0.75\n-0.4\n-0.999999999\n1709960707.2499998\n1709960707.6\n1709960707.0\n-1709960706.7500002\n-1709960706.4\n-1709960707.0\n',
  });
});

test.each(['decoding: ASCII', 'mycoding: Shift_JIS', 'foo-coding: ASCII', 'fileencoding=ASCII'])(
  'ordinary source-header keys keep UTF-8 literals executable: %s',
  (header) => {
    expect(run(`# ${header}\ns="é";s << "a";p s.bytes`)).toMatchObject({
      kind: 'executed',
      stdout: '[195, 169, 97]\n',
      uncaughtException: undefined,
    });
  }
);

test('String initialization validates the complete keyword set before construction', () => {
  expect(
    run(`class Capacity
 def to_int;puts :capacity;2;end
end
[proc{String.new('a',foo:1,bar:2)},proc{String.new('a',capacity:Capacity.new,foo:1,bar:2)}].each do |make|
 begin;make.call;rescue=>e;p e.class,e.message;end
end
p String.new('é',capacity:Capacity.new,encoding:Encoding::UTF_8).bytes`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      'ArgumentError\n"unknown keywords: :foo, :bar"\nArgumentError\n"unknown keywords: :foo, :bar"\ncapacity\n[195, 169]\n',
    uncaughtException: undefined,
  });
});

test('Enumerator reinitialization validates before committing and respects freeze', () => {
  expect(
    run(String.raw`class E < Enumerator
 def reset(*args,&block);super_init(*args,&block);end
 def super_init(*args,&block);initialize(*args,&block);end
end
[Enumerator,E].each do |type|
 [Object.new,'bad'].each do |size|
  e=type.new{|y|y<<1;y<<2}
  begin;e.send(:initialize,size){|y|y<<3};rescue=>x;p x.class;end
  p e.next
 end
 e=type.new{|y|y<<1};e.freeze
 begin;e.send(:initialize){|y|y<<3};rescue=>x;p x.class;end
end
e=Enumerator.new{|y|y<<1};o=Object.new
o.define_singleton_method(:to_int){puts :coerce;e.freeze;1}
begin;e.send(:initialize,o){|y|y<<2};rescue=>x;p x.class;end
begin;Enumerator.new;rescue=>x;p x.class,x.message;end
class Blank<Enumerator;def initialize;end;end
e=Blank.new.freeze
begin;Enumerator.instance_method(:initialize).bind(e).call{|y|y<<1};rescue=>x;p x.class,x.message;end
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      'TypeError\n1\nTypeError\n1\nFrozenError\nTypeError\n1\nTypeError\n1\nFrozenError\ncoerce\nFrozenError\nArgumentError\n"tried to create Proc object without a block"\nFrozenError\n"can\'t modify frozen Blank: #<Blank: uninitialized>"\n',
    uncaughtException: undefined,
  });
});

test('Encoded symbols retain string conversion through interpolation and dispatch', () => {
  expect(
    run(String.raw`['ASCII-8BIT','US-ASCII'].each do |encoding|
 s=String.new(255.chr,encoding:encoding);a=:"#{s}";v=:"#{a}"
 p v.encoding,v.to_s.bytes,"#{a}".bytes,"#{a}".encoding
 c=Class.new{define_method(v){7}};p [c.new].map(&v)
end
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '#<Encoding:BINARY (ASCII-8BIT)>\n[255]\n[255]\n#<Encoding:BINARY (ASCII-8BIT)>\n[7]\n#<Encoding:US-ASCII>\n[255]\n[255]\n#<Encoding:US-ASCII>\n[7]\n',
    uncaughtException: undefined,
  });
});

test('Regexp source tokens retain invalid bounds and property names before AST normalization', () => {
  for (const pattern of [
    String.raw`\X{2,1}`,
    String.raw`\Gx{3,2}`,
    String.raw`\X(a{4,2})`,
    String.raw`\X[abc]{9,2}`,
    String.raw`\X(?i:a{3,2})`,
    String.raw`\X\p{NoSuchProperty}`,
    String.raw`\G\P{NotAProperty}`,
  ]) {
    expect(run(`puts :before;p /${pattern}/`)).toMatchObject({ kind: 'compileError' });
  }
  expect(
    run(String.raw`p /[a{3,2}]/.match?('{'), /a\{3,2\}/.match?('a{3,2}'), /a(?# {3,2})/.match?('a'), /a # {3,2} \p{NoSuchProperty}
/x.match?('a'), /\p{White_Space}/.match?(' '), /\p{Greek}/.match?('α')`)
  ).toMatchObject({ kind: 'executed', stdout: 'true\ntrue\ntrue\ntrue\ntrue\ntrue\n' });
});

test('Time float conversion uses native Float conversion for rational nanoseconds', () => {
  expect(
    run(`[Rational(1,2**53+1),Rational(1,10**30),Rational(5,5**40),Rational(1,7**20),Rational(1,7)].each do |fraction|
  [0,1,-1,1709960707].each{|seconds|p (Time.at(seconds)+fraction).to_f}
end`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '1.1102230246251565e-16\n1.0000000000000002\n-1.0\n1709960707.0000002\n9.999999999999999e-31\n1.0\n-1.0\n1709960707.0\n5.4975581388800005e-28\n1.0\n-1.0\n1709960707.0000002\n1.253254289419685e-17\n1.0\n-1.0\n1709960707.0\n0.14285714285714285\n1.1428571428571428\n-0.8571428571428571\n1709960707.142857\n',
  });
});

test('Anonymous keyword-rest inspection follows the complete preceding signature', () => {
  expect(
    run(`class Signatures
 def a(x,**);end
 def b(x=1,**);end
 def c(x,**,&);end
 def d(x:,**);end
 def e(**);end
end
[:a,:b,:c,:d,:e].each{|n|p Signatures.instance_method(n).to_s.sub(/ (main\\.rb|-e):\\d+>/,'>')}`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '"#<UnboundMethod: Signatures#a(x)>"\n"#<UnboundMethod: Signatures#b(x=...)>"\n"#<UnboundMethod: Signatures#c(x, ...)>"\n"#<UnboundMethod: Signatures#d(x:)>"\n"#<UnboundMethod: Signatures#e(**)>"\n',
  });
});

test('Frozen external iterators refuse cursor mutations while allowing each', () => {
  expect(
    run(`[:next,:peek,:next_values,:peek_values,:rewind,:feed].each do |operation|
 [false,true].each do |started|
  e=Enumerator.new{|y|y<<1;y<<2};e.peek if started;e.freeze
  begin;operation==:feed ? e.feed(1) : e.send(operation);rescue=>error;p error.class;end
 end
end
e=Enumerator.new{|y|y<<1;y<<2};e.freeze;p e.each.to_a`)
  ).toMatchObject({
    kind: 'executed',
    stdout: 'FrozenError\n'.repeat(12) + '[1, 2]\n',
    uncaughtException: undefined,
  });
});

test('Enumerable sizes preserve native numeric and receiver protocols', () => {
  expect(
    run(String.raw`class E
 include Enumerable
 def initialize(size);@size=size;end
 def each;yield 1;end
 def size;@size;end
end
class Count
 def to_int;puts :converted;2;end
end
[0,nil,3].each do |size|
 begin; puts :query; p E.new(size).cycle(Count.new).size; rescue=>e;p e.class,e.message;end
end
[0,3,3.5,Rational(7,2),Rational(1,2),'3',nil,Float::INFINITY,-Float::INFINITY].each do |size|
 e=E.new(size);p size
 [:take,:drop,:each_slice,:each_cons].each do |method|
  begin;p e.lazy.send(method,2).size;rescue=>x;p x.class,x.message;end
 end
 p e.chain([1,2]).size
end
class External < Enumerator
 def initialize;super{|y|y<<1};end
 def each;yield 42;end
end
p External.new.map{|x|x},External.new.select{true},External.new.to_a
class Overridden < Enumerator
 def initialize;end
 def each;yield 42;end
end
p Overridden.new.map{|x|x}
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      'query\nconverted\n0\nquery\nconverted\nnil\nquery\nconverted\n6\n0\n0\n0\n0\n0\n2\n3\n2\n1\n2\n2\n5\n3.5\n2\n1.5\n2\n2.5\nnil\n(7/2)\n2\n(3/2)\n2\n(5/2)\nnil\n(1/2)\n2\n(-3/2)\n0\n0\nnil\n"3"\n2\nNoMethodError\n"undefined method \'-\' for an instance of String"\nTypeError\n"no implicit conversion of Integer into String"\nTypeError\n"no implicit conversion of Integer into String"\nnil\nnil\nnil\nnil\nnil\nnil\nnil\nInfinity\n2\nInfinity\nInfinity\nInfinity\nInfinity\n-Infinity\n2\n-Infinity\n-Infinity\n0\n-Infinity\n[42]\n[42]\n[42]\n[42]\n',
    stderr: '',
    uncaughtException: undefined,
  });
});

test('Encoded identifiers remain distinct across reflection, patterns and reductions', () => {
  expect(
    run(String.raw`class Missing
 def method_missing(n,*a);super;end
end
[233.chr.to_sym,('x'+255.chr).to_sym].each do |n|
 begin;Missing.new.send(n);rescue NoMethodError=>e;p e.name==n,e.message.encoding;end
end
module Constants;end
n=('A'+255.chr).to_sym;Constants.const_set(n,1);Constants.const_set(:Aÿ,2)
p Constants.const_get(n),Constants.const_get(:Aÿ),Constants.const_defined?(n)
h={233.chr.to_sym=>1,'é'.to_sym=>2};h => {"é":v,**rest};p v,rest
s=Struct.new(:a).new(1)
[233.chr.to_sym,233.chr].each do |name|
 begin;s[name];rescue NameError=>e;p e.name.class,e.name==name,e.message.encoding;end
 begin;s[name]=1;rescue NameError=>e;p e.name.class,e.name==name,e.message.encoding;end
end
class Reduction;end
n=('x'+255.chr).to_sym
Reduction.define_method(n){|x|42};Reduction.define_method(:xÿ){|x|24}
p [Reduction.new,1].inject(n),[Reduction.new,1].reduce(n.to_s)
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      'true\n#<Encoding:BINARY (ASCII-8BIT)>\ntrue\n#<Encoding:BINARY (ASCII-8BIT)>\n1\n2\ntrue\n2\n{"\\xE9": 1}\nSymbol\ntrue\n#<Encoding:BINARY (ASCII-8BIT)>\nSymbol\ntrue\n#<Encoding:BINARY (ASCII-8BIT)>\nString\ntrue\n#<Encoding:BINARY (ASCII-8BIT)>\nString\ntrue\n#<Encoding:BINARY (ASCII-8BIT)>\n42\n42\n',
    stderr: '',
    uncaughtException: undefined,
  });
});

test('Reflected class names preserve binary and US-ASCII identifier bytes', () => {
  expect(
    run(String.raw`module C;end
['ASCII-8BIT','US-ASCII'].each do |encoding|
 s=String.new('A'+255.chr,encoding:encoding);n=:"#{s}"
 begin;C.const_set(n,Class.new);p C.const_get(n).name.bytes,C.const_get(n).name.encoding,C.const_defined?(n);rescue=>e;p e.class,e.message;end
end
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '[67, 58, 58, 65, 255]\n#<Encoding:BINARY (ASCII-8BIT)>\ntrue\n[67, 58, 58, 65, 255]\n#<Encoding:US-ASCII>\ntrue\n',
    stderr: '',
    uncaughtException: undefined,
  });
});

test('Block-requiring natives report their operation-specific errors', () => {
  expect(
    run(String.raw`[proc{Class.new.define_method(:x)},proc{Object.new.define_singleton_method(:x)},proc{Enumerator.new},proc{Enumerator.produce(1)},proc{1.instance_exec},proc{Class.new.class_exec},proc{at_exit}].each do |call|
 begin;call.call;rescue=>e;p e.class,e.message;end
end
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      'ArgumentError\n"tried to create Proc object without a block"\nArgumentError\n"tried to create Proc object without a block"\nArgumentError\n"tried to create Proc object without a block"\nArgumentError\n"no block given"\nLocalJumpError\n"no block given"\nLocalJumpError\n"no block given"\nArgumentError\n"called without a block"\n',
    stderr: '',
    uncaughtException: undefined,
  });
});

test('Rational text preserves trailing-dot component and exponent boundaries', () => {
  expect(
    run(String.raw`['1.','1./2','1/2.','1_0.','1.e2','1.e-2','1./2.e2','1._2','1..2','1.e','1./2._3','.','1./.2'].each do |text|
 begin;p Rational(text);rescue=>e;p e.class,e.message;end
end
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '(1/1)\n(1/2)\n(1/2)\n(10/1)\nArgumentError\n"invalid value for convert(): \\"1.e2\\""\nArgumentError\n"invalid value for convert(): \\"1.e-2\\""\nArgumentError\n"invalid value for convert(): \\"1./2.e2\\""\nArgumentError\n"invalid value for convert(): \\"1._2\\""\nArgumentError\n"invalid value for convert(): \\"1..2\\""\nArgumentError\n"invalid value for convert(): \\"1.e\\""\nArgumentError\n"invalid value for convert(): \\"1./2._3\\""\n(0/1)\n(5/1)\n',
    stderr: '',
    uncaughtException: undefined,
  });
});

test('Named replacements preserve encoded names and validate every reference', () => {
  expect(
    run(String.raw`[233.chr,255.chr,'é'].each do |capture|
 r=Regexp.new('(?<'+capture+'>a)')
 ['é',233.chr,'ÿ',255.chr].each do |reference|
  [:sub,:gsub].each do |operation|
   begin;p 'a'.send(operation,r,'\\k<'+reference+'>');rescue=>e;p e.class,e.message,e.message.encoding;end
  end
 end
end
['\\k<no!>','\\k<>','\\k<1>','\\k<foo','\\k<','\\k','\\kX','\\\\k<foo>'].each do |replacement|
 begin;p 'a'.gsub(/(a)/,replacement);rescue=>e;p e.class,e.message;end
end
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      'IndexError\n"undefined group name reference: é"\n#<Encoding:UTF-8>\nIndexError\n"undefined group name reference: é"\n#<Encoding:UTF-8>\n"a"\n"a"\nIndexError\n"undefined group name reference: ÿ"\n#<Encoding:UTF-8>\nIndexError\n"undefined group name reference: ÿ"\n#<Encoding:UTF-8>\nIndexError\n"undefined group name reference: \\\\xFF"\n#<Encoding:BINARY (ASCII-8BIT)>\nIndexError\n"undefined group name reference: \\\\xFF"\n#<Encoding:BINARY (ASCII-8BIT)>\nIndexError\n"undefined group name reference: é"\n#<Encoding:UTF-8>\nIndexError\n"undefined group name reference: é"\n#<Encoding:UTF-8>\nIndexError\n"undefined group name reference: \\\\xE9"\n#<Encoding:BINARY (ASCII-8BIT)>\nIndexError\n"undefined group name reference: \\\\xE9"\n#<Encoding:BINARY (ASCII-8BIT)>\nIndexError\n"undefined group name reference: ÿ"\n#<Encoding:UTF-8>\nIndexError\n"undefined group name reference: ÿ"\n#<Encoding:UTF-8>\n"a"\n"a"\n"a"\n"a"\nIndexError\n"undefined group name reference: \\\\xE9"\n#<Encoding:BINARY (ASCII-8BIT)>\nIndexError\n"undefined group name reference: \\\\xE9"\n#<Encoding:BINARY (ASCII-8BIT)>\nIndexError\n"undefined group name reference: ÿ"\n#<Encoding:UTF-8>\nIndexError\n"undefined group name reference: ÿ"\n#<Encoding:UTF-8>\nIndexError\n"undefined group name reference: \\\\xFF"\n#<Encoding:BINARY (ASCII-8BIT)>\nIndexError\n"undefined group name reference: \\\\xFF"\n#<Encoding:BINARY (ASCII-8BIT)>\nIndexError\n"undefined group name reference: no!"\nIndexError\n"undefined group name reference: "\nIndexError\n"undefined group name reference: 1"\nRuntimeError\n"invalid group name reference format"\nRuntimeError\n"invalid group name reference format"\n"\\\\k"\n"\\\\kX"\n"\\\\k<foo>"\n',
    stderr: '',
    uncaughtException: undefined,
  });
});

test('Empty literal scans retain interior-byte match contexts after mutation', () => {
  expect(
    run(`['é','あ','😀'].each do |ch|
 s='a'+ch;n=0
 s.scan(''){p [$~.begin(0),$\`.bytes,$'.bytes];n+=1;s[0,2]=ch+'a' if n==1}
 p [$~.begin(0),$\`.bytes,$'.bytes]
end
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '[0, [], [97, 195, 169]]\n[1, [195], [169, 97]]\n[1, [195, 169], [97]]\n[2, [195, 169, 97], []]\n[2, [195, 169, 97], []]\n[0, [], [97, 227, 129, 130]]\n[1, [227], [129, 130, 97]]\n[2, [227, 129], [130, 97]]\n[1, [227, 129, 130], [97]]\n[2, [227, 129, 130, 97], []]\n[2, [227, 129, 130, 97], []]\n[0, [], [97, 240, 159, 152, 128]]\n[1, [240], [159, 152, 128, 97]]\n[2, [240, 159], [152, 128, 97]]\n[3, [240, 159, 152], [128, 97]]\n[1, [240, 159, 152, 128], [97]]\n[2, [240, 159, 152, 128, 97], []]\n[2, [240, 159, 152, 128, 97], []]\n',
    stderr: '',
    uncaughtException: undefined,
  });
});

test('strftime parses modifiers, widths and terminal percent tokens', () => {
  expect(
    run(String.raw`t=Time.utc(2024,2,29,13,5,9)
['%Ec|%Od|%Oe|%EY','%-%','%_%','%0%','%^%','%#%','%-10%','%010%','%_10%','%10%','%EOY','%OEY','%EN','%ON','%Eq','%Oq','%E%','%O%','%E%abc','%O%abc','%E','%O','%10E','%:','%::','%:::','%::::','tail%','%1','%_','%---','%%%','%%%%','%Ok','%Ol'].each do |format|
 begin;p [format,t.strftime(format)];rescue=>e;p [format,e.class,e.message];end
end
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '["%Ec|%Od|%Oe|%EY", "Thu Feb 29 13:05:09 2024|29|29|2024"]\n["%-%", "%"]\n["%_%", "%"]\n["%0%", "%"]\n["%^%", "%"]\n["%#%", "%"]\n["%-10%", "%"]\n["%010%", "000000000%"]\n["%_10%", "         %"]\n["%10%", "         %"]\n["%EOY", "%EOY"]\n["%OEY", "%OEY"]\n["%EN", "%EN"]\n["%ON", "%ON"]\n["%Eq", "%Eq"]\n["%Oq", "%Oq"]\n["%E%", ArgumentError, "invalid format: %E%"]\n["%O%", ArgumentError, "invalid format: %O%"]\n["%E%abc", "%EThubc"]\n["%O%abc", "%OThubc"]\n["%E", "%E"]\n["%O", "%O"]\n["%10E", "%10E"]\n["%:", "%:"]\n["%::", "%::"]\n["%:::", "%:::"]\n["%::::", ArgumentError, "invalid format: %::::"]\n["tail%", ArgumentError, "invalid format: tail%"]\n["%1", ArgumentError, "invalid format: %1"]\n["%_", ArgumentError, "invalid format: %_"]\n["%---", ArgumentError, "invalid format: %---"]\n["%%%", ArgumentError, "invalid format: %%%"]\n["%%%%", "%%"]\n["%Ok", "13"]\n["%Ol", " 1"]\n',
    stderr: '',
    uncaughtException: undefined,
  });
});

test('END warnings precede execution even in uncalled methods', () => {
  expect(
    run(String.raw`def unused
 END{puts :first}
end
class WithEnd
 def unused
  END{puts :second}
 end
end
puts :now
`)
  ).toMatchObject({
    kind: 'executed',
    stdout: 'now\n',
    stderr: 'main.rb:2: warning: END in method; use at_exit\nmain.rb:6: warning: END in method; use at_exit\n',
    uncaughtException: undefined,
  });
});

test('Quantified zero-width forms fail explicitly instead of producing host-regexp capture semantics', () => {
  const assertions = [
    '$',
    String.raw`\A`,
    String.raw`\z`,
    String.raw`\Z`,
    '(?=a)',
    '(?!a)',
    '(?<=a)',
    '(?<!a)',
    '(?:(?=(a)))',
    '()',
  ];
  for (const assertion of assertions) {
    for (const quantifier of ['+', '?', '{0}', '{1,2}']) {
      expect(run(`puts :before;Regexp.new(${JSON.stringify(assertion + quantifier)})`)).toMatchObject({
        kind: 'executed',
        stdout: 'before\n',
        uncaughtException: '正規表現の量指定されたゼロ幅表明は、この採点環境では使えません。',
      });
    }
  }
  expect(run(String.raw`p /(?:^a)?/.match?('a'), /(?=(a))/.match('a').captures`)).toMatchObject({
    kind: 'executed',
    stdout: 'true\n["a"]\n',
  });
});

test.each([
  'if /x/;puts :bad;end',
  'unless /x/;puts :bad;end',
  'x=/x/ ? 1 : 2',
  'while /x/ && false;end',
  'p !/x/',
  'p not(/x/)',
])('implicit regexp conditions fail explicitly: %s', (source) => {
  expect(run(source)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ message: '条件式内の正規表現リテラル（$_ の暗黙の参照）は、この採点環境では使えません。' }],
  });
});

test('Time aliases retain bodies, identity and nanosecond precision', () => {
  expect(
    run(String.raw`t=Time.at(Rational(-1234567891,1000000000)).utc
p t.tv_sec,t.tv_usec,t.tv_nsec,t.ctime,t.asctime,t.isdst,t.dst?
[:tv_sec,:tv_usec,:tv_nsec,:ctime,:isdst].zip([:to_i,:usec,:nsec,:asctime,:dst?]).each do |a,b|
 p [t.method(a)==t.method(b),t.method(a).hash==t.method(b).hash,t.method(a).arity,t.method(a).owner]
end
class Time
 def to_i;99;end
end
p t.to_i,t.tv_sec
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '-2\n765432\n765432109\n"Wed Dec 31 23:59:58 1969"\n"Wed Dec 31 23:59:58 1969"\nfalse\nfalse\n[true, true, 0, Time]\n[true, true, 0, Time]\n[true, true, 0, Time]\n[true, true, 0, Time]\n[true, true, 0, Time]\n99\n-2\n',
    uncaughtException: undefined,
  });
});

test('Runtime regexp properties share source validation and native diagnostics', () => {
  expect(
    run(String.raw`['\\p{Foo}','[\\p{Nope}]','\\P{^Imaginary}','\\p{foo_bar}'].each do |source|
 begin
  Regexp.new(source)
 rescue RegexpError => error
  puts error.message
 end
end
p Regexp.new('\\p{Alpha}').match?('A')
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      'invalid character property name {Foo}: /\\p{Foo}/\ninvalid character property name {Nope}: /[\\p{Nope}]/\ninvalid character property name {Imaginary}: /\\P{^Imaginary}/\ninvalid character property name {foo_bar}: /\\p{foo_bar}/\ntrue\n',
    uncaughtException: undefined,
  });
});

test.each(['iso8601', 'xmlschema'])('unavailable Time aliases preserve their own diagnostic: %s', (name) => {
  expect(run(`t=Time.new(2024);p t.method(:iso8601)==t.method(:xmlschema);t.${name}`)).toMatchObject({
    kind: 'executed',
    stdout: 'true\n',
    uncaughtException: `Time#${name} は、この採点環境では使えません。`,
  });
});

test('Time fractional formatting separates zero flags from positive precision', () => {
  expect(
    run(String.raw`t=Time.utc(2024,2,29,13,5,9,123456)
['%0N','%0L','%00N','%_0L','%000N','%03N','%003L','%0_0N','%_03N','%00d'].each{|f|p t.strftime(f)}
`)
  ).toMatchObject({
    kind: 'executed',
    stdout: '"123456000"\n"123"\n"123456000"\n"123"\n"123456000"\n"123"\n"123"\n"123456000"\n"123"\n"29"\n',
    uncaughtException: undefined,
  });
});

test('Nil String conversion declines encoded method-name coercion', () => {
  expect(
    run(String.raw`class Op
 def to_str;nil;end
 def inspect;'op';end
end
[proc{[1,2].inject(Op.new)},proc{[1,2].reduce(0,Op.new)},proc{Object.new.method(Op.new)},proc{Object.new.send(Op.new)}].each do |f|
 begin;f.call;rescue=>e;p e.class,e.message;end
end
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      'TypeError\n"op is not a symbol nor a string"\nTypeError\n"op is not a symbol nor a string"\nTypeError\n"op is not a symbol nor a string"\nTypeError\n"op is not a symbol nor a string"\n',
    uncaughtException: undefined,
  });
});

test.each([String.raw`(?=a)?\1`, String.raw`\A+\2(a)`, String.raw`(?:(?=a))*\3(a)(b)`])(
  'invalid references are rejected before unsupported assertion repetition: %s',
  (source) => {
    expect(run(`puts :before;p /${source}/`)).toMatchObject({ kind: 'compileError' });
  }
);

test.each(['Age=1.1', 'Age=17.0', 'Grapheme_Cluster_Break=Control', 'InCB=Consonant'])(
  'valid property-value syntax is unavailable rather than invalid: %s',
  (property) => {
    for (const source of [String.raw`\p{${property}}`, String.raw`[\P{^${property}}]`, String.raw`\X\p{${property}}`]) {
      const result = run(`puts :before;p /${source}/`);
      expect(result).toMatchObject({
        kind: 'executed',
        stdout: 'before\n',
        uncaughtException: expect.stringContaining('は、この採点環境では使えません。'),
      });
    }
  }
);

test('Constant reflection retains definition locations across assignment, copying and named factories', () => {
  expect(
    run(String.raw`class A
 X=1
end
A.const_set(:X,2)
A.const_set('X',3)
class A
 X=4
end
B=A.dup
B.const_set(:X,5)
class A;class C;end;end
A.const_set(:C,0)
Struct.new('WarningItem',:x)
Struct.const_set(:WarningItem,0)
p A::X,B::X
`)
  ).toMatchObject({
    kind: 'executed',
    stdout: '4\n5\n',
    stderr:
      'main.rb:4: warning: already initialized constant A::X\nmain.rb:2: warning: previous definition of X was here\nmain.rb:5: warning: already initialized constant A::X\nmain.rb:4: warning: previous definition of X was here\nmain.rb:7: warning: already initialized constant A::X\nmain.rb:5: warning: previous definition of X was here\nmain.rb:10: warning: already initialized constant B::X\nmain.rb:7: warning: previous definition of X was here\nmain.rb:12: warning: already initialized constant A::C\nmain.rb:11: warning: previous definition of C was here\nmain.rb:14: warning: already initialized constant Struct::WarningItem\nmain.rb:13: warning: previous definition of WarningItem was here\n',
    uncaughtException: undefined,
  });
});

test('Regexp property spellings use the parser Unicode canonical-name map', () => {
  expect(
    run(String.raw`['HexDigit','Hex-Digit','ASCIIHexDigit','ASCIIHEXDIGIT','SoftDotted','DashPunctuation','NoncharacterCodePoint','Latin','Canadian_Aboriginal','LowercaseLetter','XID_Start'].each do |name|
 source="\\p{#{name}}"
 r=Regexp.new(source)
 p [name,['f','x','i','-',"\uFDD0","\u1401"].map{|s|r.match?(s)}]
end
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '["HexDigit", [true, false, false, false, false, false]]\n["Hex-Digit", [true, false, false, false, false, false]]\n["ASCIIHexDigit", [true, false, false, false, false, false]]\n["ASCIIHEXDIGIT", [true, false, false, false, false, false]]\n["SoftDotted", [false, false, true, false, false, false]]\n["DashPunctuation", [false, false, false, true, false, false]]\n["NoncharacterCodePoint", [false, false, false, false, true, false]]\n["Latin", [true, true, true, false, false, false]]\n["Canadian_Aboriginal", [false, false, false, false, false, true]]\n["LowercaseLetter", [true, true, true, false, false, false]]\n["XID_Start", [true, true, true, false, false, true]]\n',
    uncaughtException: undefined,
  });
});

test.each([
  String.raw`(?=a)?(?<=a+)b`,
  String.raw`\A+(?<!a*)b`,
  String.raw`(?=a)?(?<=a*)`,
  String.raw`\A+(?<=(?=a))`,
  String.raw`(?<=a*)\z?`,
  String.raw`(a)(?<=\1)`,
  String.raw`(?<a>a)(?<=\k<a>)`,
])('source syntax completes before regexp capability checks: %s', (source) => {
  expect(run(`puts :before;p /${source}/`)).toMatchObject({ kind: 'compileError' });
});

test('Valid unsupported backreference spellings do not masquerade as source syntax errors', () => {
  for (const source of [String.raw`(?<a>x)\ka`, String.raw`[\k]`, String.raw`(?<a>x)\k'a'`]) {
    expect(run(`puts :before;p /${source}/`)).toMatchObject({
      kind: 'executed',
      stdout: 'before\n',
      uncaughtException: expect.stringContaining('は、この採点環境では使えません。'),
    });
  }
  expect(run(String.raw`puts :before;p /\k(/`)).toMatchObject({ kind: 'compileError' });
  expect(run(String.raw`p /(?<a>x)\k<a>/.match('xx')[0]`)).toMatchObject({
    kind: 'executed',
    stdout: '"xx"\n',
    uncaughtException: undefined,
  });
});

test('Hash patterns validate all keys before matching values and preserve late value lookup', () => {
  expect(
    run(String.raw`begin
 case {a:1};in {a:2,b:1};end
rescue =>e;p e.class,e.message;end
begin
 case {x:1};in {x:{a:2},b:1};end
rescue =>e;p e.class,e.message;end
x=nil
begin
 {a:1} => {a:x,b:y}
rescue =>e;p e.class,x;end
h={a:1,b:2}
calls=[]
module G;end
G.define_singleton_method(:===){|v|calls<<v;h[:b]=3;true}
case h;in {a:G,b:3};p :matched;end
p calls
calls.clear
case {a:1};in {a:G,b:2};p :bad;else;p :missing;end
p calls
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      'NoMatchingPatternKeyError\n"{a: 1}: key not found: :b"\nNoMatchingPatternKeyError\n"{x: 1}: key not found: :b"\nNoMatchingPatternKeyError\nnil\n:matched\n[1]\n:missing\n[]\n',
    uncaughtException: undefined,
  });
});

test('Space-padded time zones retain the native minimum offset width', () => {
  expect(
    run(String.raw`['+00:00','+09:00','-00:30','+01:02:03'].each do |offset|
 t=Time.at(0).getlocal(offset)
 p t.strftime('%_1z|%_3z|%_z|%_8z|%_1:z|%_3::z|%_1:::z')
end
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '" +000| +000| +000|    +000| +0:00| +0:00:00| +0"\n" +900| +900| +900|    +900| +9:00| +9:00:00| +9"\n" -030| -030| -030|    -030| -0:30| -0:30:00| -0:30"\n" +102| +102| +102|    +102| +1:02| +1:02:03| +1:02:03"\n',
    uncaughtException: undefined,
  });
});

test('Extended regexp composition shares scoped lexical rules with source analysis', () => {
  expect(
    run(String.raw`r=/a b/x
p Regexp.union(r,/c/).match?('ab'), /#{r}/.match?('ab')
p Regexp.union(/a \# b # comment
 c/x,/d/).match?('a#bc')
p /(?x:a b(?-x: c d)e f)/.match?('ab c def')
p /(?x:a[ #]b)/.match?('a b'), /(?x:a[ #]b)/.match?('a#b')
p /(?x:a # (?<fake>x) \p{NotAProperty}
 (?<real>b))/.names
p /(?x:a # (?<fake>x)
 (?<real>b))/.match('ab').captures
p /(?x:a(?: b )c) d/.match?('abc d')
p /(?x:a(?-x:# )b)/.match?('a# b')
p /(?x:a\ b)/.match?('a b')
p /a(?x) b/.match?('ab')
`)
  ).toMatchObject({
    kind: 'executed',
    stdout: 'true\ntrue\ntrue\ntrue\ntrue\ntrue\n["real"]\n["b"]\ntrue\ntrue\ntrue\ntrue\n',
    uncaughtException: undefined,
  });
});

test('Defined receiver probes recurse through literal aggregates without changing interpolation or assignment', () => {
  expect(
    run(String.raw`p defined?([$missing][0]),defined?([1,$missing].size),defined?({a:$missing}[:a]),defined?({a:$missing}.values[0])
p defined?([@missing,[1,$missing]].size),defined?({$missing=>1}.size)
p defined?([1][0]),defined?("#{$missing}x"[0]),defined?(1..$missing)
p defined?(($g=2).abs),$g
class C
 p defined?([@@missing].size),defined?({a:@@missing}.size)
end
`)
  ).toMatchObject({
    kind: 'executed',
    stdout: 'nil\nnil\nnil\nnil\nnil\nnil\n"method"\n"method"\n"expression"\n"method"\n2\nnil\nnil\n',
    uncaughtException: undefined,
  });
});

test('Explicit numeric strftime widths replace default field padding', () => {
  expect(
    run(String.raw`t=Time.utc(24,2,3,1,5,9)
%w[Y C y m d e j u w U W V G g H k I l M S s].each do |d|
 p [d,t.strftime("%1#{d}|%2#{d}|%_1#{d}|%03#{d}|%-4#{d}")]
end
p t.strftime('%1F|%1T|%0N|%1L|%_1z')
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '["Y", "24|24|24|024|24"]\n["C", "0|00|0|000|0"]\n["y", "24|24|24|024|24"]\n["m", "2|02|2|002|2"]\n["d", "3|03|3|003|3"]\n["e", "3| 3|3|003|3"]\n["j", "34|34|34|034|34"]\n["u", "6|06|6|006|6"]\n["w", "6|06|6|006|6"]\n["U", "4|04|4|004|4"]\n["W", "5|05|5|005|5"]\n["V", "5|05|5|005|5"]\n["G", "24|24|24|024|24"]\n["g", "24|24|24|024|24"]\n["H", "1|01|1|001|1"]\n["k", "1| 1|1|001|1"]\n["I", "1|01|1|001|1"]\n["l", "1| 1|1|001|1"]\n["M", "5|05|5|005|5"]\n["S", "9|09|9|009|9"]\n["s", "-61406981691|-61406981691|-61406981691|-61406981691|-61406981691"]\n"0024-02-03|01:05:09|000000000|0| +000"\n',
    uncaughtException: undefined,
  });
});

test('Extended lexical scopes preserve negated class boundaries', () => {
  expect(run(String.raw`p /(?x:[^^] a)/.match?('ba'), /(?x:[^^] a)/.match?('^a')`)).toMatchObject({
    kind: 'executed',
    stdout: 'true\nfalse\n',
    uncaughtException: undefined,
  });
});

test('Yielder keywords and collection overrides retain Ruby dispatch protocols', () => {
  expect(
    run(String.raw`y=Enumerator::Yielder.new{|a:,**rest|p a,rest}
y.yield(a:1,b:2)
y.yield(a:3)
y.to_proc.call(a:4,c:5)
e=Enumerator.new{|out|out.yield(a:6)}
e.each{|a:|p a}
class X<Array
 define_method(:hash){1}
 define_method(:eql?){|other|true}
end
x=X.new([1]);y=X.new([2]);p({[x]=>:ok}[[y]])
a=[1];b=[2]
[a,b].each{|item|item.define_singleton_method(:hash){1};item.define_singleton_method(:eql?){|other|true}}
p({[a]=>:singleton}[[b]])
class String;define_method(:==){|other|true};end
class Symbol;define_method(:==){|other|true};end
class TrueClass;define_method(:==){|other|true};end
class FalseClass;define_method(:==){|other|true};end
p(1=='x',1==:x,1==true,1==false,1.0=='x')
`)
  ).toMatchObject({
    kind: 'executed',
    stdout: '1\n{b: 2}\n3\n{}\n4\n{c: 5}\n6\n:ok\n:singleton\ntrue\ntrue\ntrue\ntrue\ntrue\n',
    uncaughtException: undefined,
  });
});

test('Every record allocator establishes member storage for reflection and inheritance', () => {
  expect(
    run(String.raw`[Struct,Data].each do |base|
 begin;Class.instance_method(:allocate).bind(base).call;rescue TypeError=>e;puts e.message;end
end
S=Struct.new(:x,:y)
s=Class.instance_method(:allocate).bind(S).call
p s.to_a,s.to_h,s.members
D=Data.define(:x)
d=Class.instance_method(:allocate).bind(D).call
p d.members,d.to_h,d.frozen?
class T<S;end
p Class.instance_method(:allocate).bind(T).call.to_a
C=S.dup
p Class.instance_method(:allocate).bind(C).call.to_a
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      'allocator undefined for Struct\nallocator undefined for Data\n[nil, nil]\n{x: nil, y: nil}\n[:x, :y]\n[:x]\n{x: nil}\nfalse\n[nil, nil]\n[nil, nil]\n',
    uncaughtException: undefined,
  });
});

test('Native reflection preserves declared signatures through aliases, copies and binding', () => {
  expect(
    run(String.raw`p Time.instance_method(:initialize).parameters
p Rational.instance_method(:marshal_dump).arity
m=Struct.instance_method(:select);p m.owner,m.arity,m.parameters
class S<Struct.new(:x)
 alias pick select
 define_method(:choice,instance_method(:select))
end
s=S.new(1)
[:select,:pick,:choice].each{|name|m=s.method(name);p m.arity,m.parameters,m.call{|x|x==1}}
x=s.method(:select).unbind.bind(s);p x.arity,x.parameters,x.call{|v|true}
p Method.instance_method(:clone).arity
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '[[:opt, :year], [:opt, :mon], [:opt, :mday], [:opt, :hour], [:opt, :min], [:opt, :sec], [:opt, :zone], [:key, :in], [:key, :precision]]\n0\nStruct\n-1\n[[:rest]]\n-1\n[[:rest]]\n[1]\n-1\n[[:rest]]\n[1]\n-1\n[[:rest]]\n[1]\n-1\n[[:rest]]\n[1]\n0\n',
    uncaughtException: undefined,
  });
});

test('Mutable deconstruction retains live arrays and Ruby slice bounds', () => {
  expect(
    run(String.raw`module Clear
 def self.===(v);$a.clear;true;end
end
module Pop
 def self.===(v);$a.pop;true;end
end
$a=[1,2];p(($a in [Clear,nil]))
$a=[1,2];p(($a in [Pop,nil]))
$a=[1,2,3];p(($a in [Pop,*rest,nil]));p rest
$a=[1,2,3];p(($a in [Clear,*rest,nil]));p rest
$a=[1,2];p(($a in [*before,Clear,nil]));p before
`)
  ).toMatchObject({
    kind: 'executed',
    stdout: 'true\ntrue\nfalse\n[]\ntrue\nnil\ntrue\n[]\n',
    uncaughtException: undefined,
  });
});

test('Regexp repeat limits are source errors in dynamic construction', () => {
  expect(
    run(String.raw`['a{100001}','a{0,100001}','a{100001,}','a{,100001}','{100001}'].each do |source|
 begin;Regexp.new(source);rescue RegexpError=>e;puts e.message;end
end
p Regexp.new('a{100000}').source
p Regexp.new('[{100001}]').match?('1')
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      'too big number for repeat range: /a{100001}/\ntoo big number for repeat range: /a{0,100001}/\ntoo big number for repeat range: /a{100001,}/\ntoo big number for repeat range: /a{,100001}/\ntoo big number for repeat range: /{100001}/\n"a{100000}"\ntrue\n',
    uncaughtException: undefined,
  });
});

test.each(['a{100001}', 'a{0,100001}', 'a{100001,}', 'a{,100001}'])(
  'oversized regexp repeat rejects before execution: %s',
  (source) => {
    expect(run(`puts :before;p /${source}/`)).toMatchObject({ kind: 'compileError' });
  }
);

test.each([
  String.raw`p "ß".match?(/s{2}/i)`,
  String.raw`p "ﬀ".match?(/f+/i)`,
  String.raw`p "ß".match?(/(s)(s)/i)`,
  String.raw`p "ß".match?(/(?i:s{2})/)`,
  String.raw`p "ss".match?(/\u00df/i)`,
])('Unicode expansion is refused regardless of regexp structure: %s', (source) => {
  expect(run(source)).toMatchObject({
    kind: 'executed',
    uncaughtException: 'Unicode の複数文字 casefold は、この採点環境では使えません。',
  });
});

test.each([String.raw`p "ss".match?(/\A[a-ÿ]\z/i)`, String.raw`p "ss".match?(/\A\p{Lower}\z/i)`])(
  'casefold expansion through character sets fails explicitly: %s',
  (source) => {
    expect(run(source)).toMatchObject({
      kind: 'executed',
      uncaughtException: 'Unicode の複数文字 casefold は、この採点環境では使えません。',
    });
  }
);

test('Ruby regexp token boundaries distinguish ignored text, escapes and literal braces', () => {
  expect(
    run(String.raw`['(?x:\x 61)','(?x:\u 0061)',"(?x:\\x# comment\n61)","(?x:\\u# comment\n0061)"].each do |source|
 begin;Regexp.new(source);rescue RegexpError=>e;puts e.message;end
end
p /(?x:a{ 2 })/.match?('a{2}'),/(?x:a{ 2 })/.match?('aa')
p /(?x:a{ 2,3 })/.match?('a{2,3}'),/(?x:a{ 2,3 })/.match?('aa')
r=Regexp.new("(?x:a # comment"+"\\"+"\n b\n c)")
p r.match?('abc'),r.match?('ac')
r=/(?x:a # comment\
 b
 c)/
p r.match?('ac'),r.match?('abc')
source="(?x:a # "+'\p{Invalid}\u{bogus}\x'+"\n b)"
p Regexp.new(source).match?('ab')
p /(?x:a{2})/.match?('aa'),/(?x:a\{ 2 \})/.match?('a{2}')
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      'invalid hex escape: /(?x:\\x 61)/\ninvalid Unicode escape: /(?x:\\u 0061)/\ninvalid hex escape: /(?x:\\x# comment\n61)/\ninvalid Unicode escape: /(?x:\\u# comment\n0061)/\ntrue\nfalse\ntrue\nfalse\ntrue\nfalse\ntrue\nfalse\ntrue\ntrue\ntrue\n',
    stderr: '',
    uncaughtException: undefined,
  });
});

test('Native aliases control unary negation and primitive formatting', () => {
  expect(
    run(String.raw`class C;alias ! frozen?;end
o=C.new.freeze;p !o
class D;alias ! to_s;end
p((!D.new).class)
class Integer;alias to_s chr;end
puts 65
class Integer;alias inspect chr;end
p 66
`)
  ).toMatchObject({ kind: 'executed', stdout: 'true\nString\nA\nB\n', stderr: '', uncaughtException: undefined });
});

test('Native iterator aliases retain Enumerable traversal and tie order', () => {
  expect(
    run(String.raw`class Array;alias each reverse_each;end
p [1,2,3].entries,[1,2,3].sort_by{|x|x%2}
`)
  ).toMatchObject({ kind: 'executed', stdout: '[3, 2, 1]\n[2, 3, 1]\n', stderr: '', uncaughtException: undefined });
});

test('Native comparator aliases use normal sort_by comparison', () => {
  expect(
    run(String.raw`class Integer;alias <=> +;end
p [3,1,2].sort_by{|x|x}
`)
  ).toMatchObject({ kind: 'executed', stdout: '[2, 1, 3]\n', stderr: '', uncaughtException: undefined });
});

test('Pattern key errors accept keyword metadata and preserve it on message replacement', () => {
  expect(
    run(String.raw`e=NoMatchingPatternKeyError.new('missing',key: :a,matchee:{a:1})
p e.message,e.key,e.matchee
e.send(:initialize,'changed')
p e.message,e.key,e.matchee
n=NoMatchingPatternKeyError.new(key:nil,matchee:nil)
p n.message,n.key,n.matchee
begin;NoMatchingPatternKeyError.new(unknown:1);rescue=>e;p e.class,e.message;end
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '"missing"\n:a\n{a: 1}\n"changed"\n:a\n{a: 1}\n"NoMatchingPatternKeyError"\nnil\nnil\nArgumentError\n"unknown keyword: :unknown"\n',
    stderr: '',
    uncaughtException: undefined,
  });
});

test('Defined receiver probes inspect call arguments while retaining block-call semantics', () => {
  expect(
    run(String.raw`a=[]
p defined?(a.push($missing).size),a
p defined?(a.push([[$missing]]).size),a
p defined?(a.push({k:$missing}).size),a
p defined?(a.push(2).size),a
class C
 attr_reader :arr
 def initialize;@arr=[];end
end
o=C.new
p defined?(o.instance_variable_set(:@arr,[$missing])[0]),o.arr
p defined?(a.push($missing){}.size),a
`)
  ).toMatchObject({
    kind: 'executed',
    stdout: 'nil\n[]\nnil\n[]\nnil\n[]\n"method"\n[2]\nnil\n[]\n"method"\n[2, nil]\n',
    stderr: '',
    uncaughtException: undefined,
  });
});

test('Proc-defined methods retain lexical yield and invocation block parameters separately', () => {
  expect(
    run(String.raw`class C;end
def install(klass)
 klass.define_method(:f){|&block|[yield(7),block_given?,block.call]}
end
install(C){|n|n*2}
p C.new.f{99}
class D
 define_method(:f){|&block|[block_given?,block.call]}
end
p D.new.f{42}
class E;end
def install_empty(klass)
 klass.define_method(:f){|&block|[defined?(yield),block_given?,block.call]}
end
install_empty(E)
p E.new.f{8}
def proc_blocks
 callable=proc{|&callback|[block_given?,yield(3),callback ? callback.call : :none]}
 [callable.call,callable.call{9}]
end
p proc_blocks{|n|n*2}
`)
  ).toMatchObject({
    kind: 'executed',
    stdout: '[14, true, 99]\n[false, 42]\n[nil, false, 8]\n[[true, 6, :none], [true, 6, 9]]\n',
    uncaughtException: undefined,
  });
});

test('Standalone negated Unicode properties preserve their distinct fold order', () => {
  expect(
    run(String.raw`['a','A','!'].each do |s|
 p [s,/\P{Lower}/i.match?(s),/[\P{Lower}]/i.match?(s),/\p{^Upper}/i.match?(s),/[\p{^Upper}]/i.match?(s)]
end
p /(?i:\P{Ll})/.match?('a')
`)
  ).toMatchObject({
    kind: 'executed',
    stdout: '["a", false, true, false, true]\n["A", false, true, false, true]\n["!", true, true, true, true]\nfalse\n',
    stderr: '',
    uncaughtException: undefined,
  });
});

test('Rational remainders follow Numeric operation order with finite and nonfinite divisors', () => {
  expect(
    run(String.raw`[Rational(2,3),Rational(-2,3)].each do |r|
 [0.1,-0.1,1,0.0,-0.0,Float::INFINITY,-Float::INFINITY,Float::NAN].each do |divisor|
  [:%,:modulo,:remainder,:div,:divmod,:fdiv].each do |op|
   begin;p [r,divisor,op,r.send(op,divisor)];rescue=>e;p [r,divisor,op,e.class,e.message];end
  end
 end
end
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '[(2/3), 0.1, :%, 0.06666666666666654]\n[(2/3), 0.1, :modulo, 0.06666666666666654]\n[(2/3), 0.1, :remainder, 0.06666666666666654]\n[(2/3), 0.1, :div, 6]\n[(2/3), 0.1, :divmod, [6, 0.06666666666666654]]\n[(2/3), 0.1, :fdiv, 6.666666666666666]\n[(2/3), -0.1, :%, -0.03333333333333344]\n[(2/3), -0.1, :modulo, -0.03333333333333344]\n[(2/3), -0.1, :remainder, 0.06666666666666657]\n[(2/3), -0.1, :div, -7]\n[(2/3), -0.1, :divmod, [-7, -0.03333333333333344]]\n[(2/3), -0.1, :fdiv, -6.666666666666666]\n[(2/3), 1, :%, (2/3)]\n[(2/3), 1, :modulo, (2/3)]\n[(2/3), 1, :remainder, (2/3)]\n[(2/3), 1, :div, 0]\n[(2/3), 1, :divmod, [0, (2/3)]]\n[(2/3), 1, :fdiv, 0.6666666666666666]\n[(2/3), 0.0, :%, ZeroDivisionError, "divided by 0"]\n[(2/3), 0.0, :modulo, ZeroDivisionError, "divided by 0"]\n[(2/3), 0.0, :remainder, ZeroDivisionError, "divided by 0"]\n[(2/3), 0.0, :div, ZeroDivisionError, "divided by 0"]\n[(2/3), 0.0, :divmod, ZeroDivisionError, "divided by 0"]\n[(2/3), 0.0, :fdiv, Infinity]\n[(2/3), -0.0, :%, ZeroDivisionError, "divided by 0"]\n[(2/3), -0.0, :modulo, ZeroDivisionError, "divided by 0"]\n[(2/3), -0.0, :remainder, ZeroDivisionError, "divided by 0"]\n[(2/3), -0.0, :div, ZeroDivisionError, "divided by 0"]\n[(2/3), -0.0, :divmod, ZeroDivisionError, "divided by 0"]\n[(2/3), -0.0, :fdiv, Infinity]\n[(2/3), Infinity, :%, NaN]\n[(2/3), Infinity, :modulo, NaN]\n[(2/3), Infinity, :remainder, NaN]\n[(2/3), Infinity, :div, 0]\n[(2/3), Infinity, :divmod, [0, NaN]]\n[(2/3), Infinity, :fdiv, 0.0]\n[(2/3), -Infinity, :%, NaN]\n[(2/3), -Infinity, :modulo, NaN]\n[(2/3), -Infinity, :remainder, (2/3)]\n[(2/3), -Infinity, :div, 0]\n[(2/3), -Infinity, :divmod, [0, NaN]]\n[(2/3), -Infinity, :fdiv, -0.0]\n[(2/3), NaN, :%, FloatDomainError, "NaN"]\n[(2/3), NaN, :modulo, FloatDomainError, "NaN"]\n[(2/3), NaN, :remainder, FloatDomainError, "NaN"]\n[(2/3), NaN, :div, FloatDomainError, "NaN"]\n[(2/3), NaN, :divmod, FloatDomainError, "NaN"]\n[(2/3), NaN, :fdiv, NaN]\n[(-2/3), 0.1, :%, 0.03333333333333344]\n[(-2/3), 0.1, :modulo, 0.03333333333333344]\n[(-2/3), 0.1, :remainder, -0.06666666666666657]\n[(-2/3), 0.1, :div, -7]\n[(-2/3), 0.1, :divmod, [-7, 0.03333333333333344]]\n[(-2/3), 0.1, :fdiv, -6.666666666666666]\n[(-2/3), -0.1, :%, -0.06666666666666654]\n[(-2/3), -0.1, :modulo, -0.06666666666666654]\n[(-2/3), -0.1, :remainder, -0.06666666666666654]\n[(-2/3), -0.1, :div, 6]\n[(-2/3), -0.1, :divmod, [6, -0.06666666666666654]]\n[(-2/3), -0.1, :fdiv, 6.666666666666666]\n[(-2/3), 1, :%, (1/3)]\n[(-2/3), 1, :modulo, (1/3)]\n[(-2/3), 1, :remainder, (-2/3)]\n[(-2/3), 1, :div, -1]\n[(-2/3), 1, :divmod, [-1, (1/3)]]\n[(-2/3), 1, :fdiv, -0.6666666666666666]\n[(-2/3), 0.0, :%, ZeroDivisionError, "divided by 0"]\n[(-2/3), 0.0, :modulo, ZeroDivisionError, "divided by 0"]\n[(-2/3), 0.0, :remainder, ZeroDivisionError, "divided by 0"]\n[(-2/3), 0.0, :div, ZeroDivisionError, "divided by 0"]\n[(-2/3), 0.0, :divmod, ZeroDivisionError, "divided by 0"]\n[(-2/3), 0.0, :fdiv, -Infinity]\n[(-2/3), -0.0, :%, ZeroDivisionError, "divided by 0"]\n[(-2/3), -0.0, :modulo, ZeroDivisionError, "divided by 0"]\n[(-2/3), -0.0, :remainder, ZeroDivisionError, "divided by 0"]\n[(-2/3), -0.0, :div, ZeroDivisionError, "divided by 0"]\n[(-2/3), -0.0, :divmod, ZeroDivisionError, "divided by 0"]\n[(-2/3), -0.0, :fdiv, -Infinity]\n[(-2/3), Infinity, :%, NaN]\n[(-2/3), Infinity, :modulo, NaN]\n[(-2/3), Infinity, :remainder, (-2/3)]\n[(-2/3), Infinity, :div, 0]\n[(-2/3), Infinity, :divmod, [0, NaN]]\n[(-2/3), Infinity, :fdiv, -0.0]\n[(-2/3), -Infinity, :%, NaN]\n[(-2/3), -Infinity, :modulo, NaN]\n[(-2/3), -Infinity, :remainder, NaN]\n[(-2/3), -Infinity, :div, 0]\n[(-2/3), -Infinity, :divmod, [0, NaN]]\n[(-2/3), -Infinity, :fdiv, 0.0]\n[(-2/3), NaN, :%, FloatDomainError, "NaN"]\n[(-2/3), NaN, :modulo, FloatDomainError, "NaN"]\n[(-2/3), NaN, :remainder, FloatDomainError, "NaN"]\n[(-2/3), NaN, :div, FloatDomainError, "NaN"]\n[(-2/3), NaN, :divmod, FloatDomainError, "NaN"]\n[(-2/3), NaN, :fdiv, NaN]\n',
    stderr: '',
    uncaughtException: undefined,
  });
});

test('Time String dispatch validates year tokens independently of calendar argument coercion', () => {
  expect(
    run(String.raw`['24','99','+24','-1','','abcd',' 2024','2024 '].each do |s|
 begin;p Time.new(s).year;rescue ArgumentError=>e;puts e.message;end
end
['0001','2024','+024','-024','12345'].each{|s|p Time.new(s).year}
p Time.new('24',1).year,Time.local('24').year
class Year
 def to_str;'2024';end
end
p Time.new(Year.new).year
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      'year must be 4 or more digits: 24\nyear must be 4 or more digits: 99\nyear must be 4 or more digits: +24\nyear must be 4 or more digits: -1\ncan\'t parse: ""\ncan\'t parse: "abcd"\ncan\'t parse: " 2024"\ncan\'t parse: "2024 "\n1\n2024\n24\n-24\n12345\n24\n24\n2024\n',
    stderr: '',
    uncaughtException: undefined,
  });
});

test('Binary newline matching retains byte-oriented R semantics', () => {
  expect(
    run(String.raw`s=String.new(encoding:'ASCII-8BIT');s<<133
p /\R/.match?(s),s.gsub(/\R/,'-').bytes
p /\R/.match?("\u0085"),/\R/.match?("\u2028")
p String.new("\r\n",encoding:'ASCII-8BIT').gsub(/\R/,'-').bytes
p Regexp.new(String.new('\\R',encoding:'ASCII-8BIT')).match?(s)
`)
  ).toMatchObject({
    kind: 'executed',
    stdout: 'false\n[133]\ntrue\ntrue\n[45]\nfalse\n',
    stderr: '',
    uncaughtException: undefined,
  });
});

test('Regexp text merges only a single complete root option group', () => {
  expect(
    run(String.raw`[/a/,/(?:a)/,/(?x:a b)/,/(?i:(?-m:a))/,/(?i:a)|b/,/(?i:a)(b)/,/(?x:a b) /x,/(?x:a b) /,/(?i:a)(?#tail)/,/(?i:a(?#inner))/].each{|r|p r.to_s}
p Regexp.union(/(?x:a b)/,/c/).source
[/(?x)a b/,/(?x)(?-x)a b/,/(?x)(?x:a b)/,/(?i-i:a)/,/(?ii-ii:a)/,/(?x-x:a b)/].each{|r|p r.to_s}
p /(?i-i:a)/.match?('A'),/(?ii-ii:a)/.match?('A'),/(?x-x:a b)/.match?('a b')
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '"(?-mix:a)"\n"(?-mix:a)"\n"(?x-mi:a b)"\n"(?i-mx:(?-m:a))"\n"(?-mix:(?i:a)|b)"\n"(?-mix:(?i:a)(b))"\n"(?x-mi:(?x:a b) )"\n"(?-mix:(?x:a b) )"\n"(?-mix:(?i:a)(?#tail))"\n"(?i-mx:a(?#inner))"\n"(?x-mi:a b)|(?-mix:c)"\n"(?x-mi:a b)"\n"(?-mix:a b)"\n"(?x-mi:a b)"\n"(?-mix:a)"\n"(?-mix:a)"\n"(?-mix:a b)"\nfalse\nfalse\ntrue\n',
    uncaughtException: undefined,
  });
});

test('Regexp copies warn at the call site without coercing ignored options', () => {
  expect(
    run(String.raw`p Regexp.new(/a/i,nil)
p Regexp.new(/b/,false)
p Regexp.compile(/c/,0)
class Options
 def to_int;raise 'must not coerce';end
end
p Regexp.new(/d/,Options.new)
`)
  ).toMatchObject({
    kind: 'executed',
    stdout: '/a/i\n/b/\n/c/\n/d/\n',
    stderr: 'main.rb:2: warning: flags ignored\nmain.rb:3: warning: flags ignored\nmain.rb:7: warning: flags ignored\n',
    uncaughtException: undefined,
  });
});

test.each(['foo!', 'a b', ':x', 'a.b', 'a:b', '+a', ' a'])(
  'Ruby capture names outside host identifiers fail explicitly: %s',
  (name) => {
    expect(run(`puts :before;p /(?<${name}>a)/`)).toMatchObject({
      kind: 'executed',
      stdout: 'before\n',
      uncaughtException: '正規表現の特殊なキャプチャ名は、この採点環境では使えません。',
    });
    expect(run(`puts :before;Regexp.new(${JSON.stringify(`(?<${name}>a)`)})`)).toMatchObject({
      kind: 'executed',
      stdout: 'before\n',
      uncaughtException: '正規表現の特殊なキャプチャ名は、この採点環境では使えません。',
    });
  }
);

test.each([String.raw`(?<a b>a)(?<=x*)`, String.raw`(?<a b>a)\1`])(
  'capture capability checks follow all syntax validation: %s',
  (source) => {
    expect(run(`puts :before;p /${source}/`)).toMatchObject({ kind: 'compileError' });
  }
);

test.each([
  String.raw`p /(?x:a # \x
 b)/`,
  String.raw`p /(?x:a # \u{bogus}
 b)/`,
])('source regexp escapes are checked before engine comment handling: %s', (source) => {
  expect(run(`puts :before;${source}`)).toMatchObject({ kind: 'compileError' });
});

test.each(['2024-01-01 00:00:00', '2024-01-01 00:00:00+09:00'])(
  'unsupported Time String forms do not become calendar years: %s',
  (source) => {
    expect(run(`Time.new(${JSON.stringify(source)})`)).toMatchObject({
      kind: 'executed',
      uncaughtException: 'Time.new の文字列形式は、この採点環境では使えません。',
    });
  }
);

test('Pretty printing dispatches native inspect aliases at the object boundary', () => {
  const result = run('class C;alias inspect to_s;def initialize;@x=1;end;end;pp C.new;pp [C.new]');
  if (result.kind !== 'executed') throw new Error(JSON.stringify(result));
  expect(result.uncaughtException).toBeUndefined();
  expect(result.stdout).not.toContain('@x');
  expect(result.stdout).toMatch(/^#<C:0x[\da-f]+>\n\[#<C:0x[\da-f]+>\]\n$/);
  expect(run('class E;undef inspect;def initialize;@x=1;end;end;pp E.new')).toMatchObject({
    kind: 'executed',
    stdout: expect.stringContaining('@x=1'),
    uncaughtException: undefined,
  });
});

test('Bound native Method objects retain receiver-compatible implementations', () => {
  expect(
    run(
      String.raw`p DATA.inspect==DATA.method(:inspect).call
p DATA.inspect==DATA.method(:inspect).to_proc.call
p DATA.inspect==DATA.method(:inspect).unbind.bind(DATA).call
p DATA.inspect==DATA.method(:inspect).unbind.bind_call(DATA)
p DATA.method(:read).call
p DATA.method(:rewind).call
p DATA.method(:read).to_proc.call
__END__
hello
`
    )
  ).toMatchObject({
    kind: 'executed',
    stdout:
      'true\ntrue\ntrue\ntrue\n"hello\\n"\n0\n"p DATA.inspect==DATA.method(:inspect).call\\np DATA.inspect==DATA.method(:inspect).to_proc.call\\np DATA.inspect==DATA.method(:inspect).unbind.bind(DATA).call\\np DATA.inspect==DATA.method(:inspect).unbind.bind_call(DATA)\\np DATA.method(:read).call\\np DATA.method(:rewind).call\\np DATA.method(:read).to_proc.call\\n__END__\\nhello\\n"\n',
    uncaughtException: undefined,
  });
});

test('Native Enumerator consumers retain keyword yield tuples', () => {
  expect(
    run(
      String.raw`[false,true].each do |adapter|
 e=Enumerator.new do |y|
  if adapter;y.to_proc.call(a:1);y.to_proc.call(1,a:2)
  else;y.yield(a:1);y.yield(1,a:2);end
 end
 p e.next,e.next;e.rewind;p e.next_values,e.next_values
 e.rewind;p e.to_a
 e.rewind;p e.with_index.to_a
 e.rewind;p e.with_object(:memo).to_a
 e.rewind;p e.lazy.map{|x|x}.force
 e.rewind;p e.lazy.with_index.force
end
class K
 def self.echo(a:);a;end
end
p K.method(:echo).to_proc.call(a:7)
p :echo.to_proc.call(K,a:8)
y=Enumerator::Yielder.new{|a:|p a};y.yield(a:9);y.to_proc.call(a:10)
`
    )
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '{a: 1}\n[1, {a: 2}]\n[{a: 1}]\n[1, {a: 2}]\n[{a: 1}, [1, {a: 2}]]\n[[{a: 1}, 0], [[1, {a: 2}], 1]]\n[[{a: 1}, :memo], [[1, {a: 2}], :memo]]\n[{a: 1}, 1]\n[[{a: 1}, 0], [[1, {a: 2}], 1]]\n{a: 1}\n[1, {a: 2}]\n[{a: 1}]\n[1, {a: 2}]\n[{a: 1}, [1, {a: 2}]]\n[[{a: 1}, 0], [[1, {a: 2}], 1]]\n[[{a: 1}, :memo], [[1, {a: 2}], :memo]]\n[{a: 1}, 1]\n[[{a: 1}, 0], [[1, {a: 2}], 1]]\n7\n8\n9\n10\n',
    uncaughtException: undefined,
  });
});

test('Find patterns fix candidate count while retaining live element reads', () => {
  expect(
    run(
      String.raw`module M
 def self.===(v)
  $calls+=1
  case $op
  when :pop;$a.pop
  when :shift;$a.shift
  when :push;$a.push(9)
  when :unshift;$a.unshift(0)
  end
  true
 end
end
[:pop,:shift,:push,:unshift].each do |op|
 $op=op;$calls=0;$a=[1,2,3]
 p(($a in [*,M,nil,*r]));p r,$a,$calls
 $calls=0;$a=[1,2,3]
 p(($a in [*r,M,nil,*z]));p r,z,$a,$calls
end
`
    )
  ).toMatchObject({
    kind: 'executed',
    stdout:
      'true\nnil\n[1]\n2\ntrue\n[1]\nnil\n[1]\n2\ntrue\nnil\n[3]\n2\ntrue\n[3]\nnil\n[3]\n2\nfalse\nnil\n[1, 2, 3, 9, 9]\n2\nfalse\nnil\nnil\n[1, 2, 3, 9, 9]\n2\nfalse\nnil\n[0, 0, 1, 2, 3]\n2\nfalse\nnil\nnil\n[0, 0, 1, 2, 3]\n2\n',
    uncaughtException: undefined,
  });
});

test.each([
  'p "ss".match?(/ẞ/i)',
  'p "ẞ".match?(/ss/i)',
  'p "ẞ".match?(/s{2}/i)',
  'p "ss".match?(/[ẞ]/i)',
  String.raw`p "SS".match?(/\u1e9e/i)`,
])('Capital casefold expansions fail explicitly: %s', (source) => {
  expect(run(source)).toMatchObject({
    kind: 'executed',
    uncaughtException: 'Unicode の複数文字 casefold は、この採点環境では使えません。',
  });
});

test('Ruby interval tokens ignore comments while preserving whitespace boundaries', () => {
  expect(
    run(
      String.raw`['a{#hi\n2}b','a{2#hi\n}b','a{2,#hi\n3}b','a{1#hi\n2}b','a{2#hi\n,#more\n3}b','a{(?#hi)2}b','a{2,(?#hi)3}b','a{#hi\n 2}b','a{2 #hi\n}b','a{2,#hi\n 3}b','a{ 2 }b'].each do |raw|
 source=raw.gsub('\\n',"\n")
 r=Regexp.new('\\A(?x:'+source+')\\z')
 p ['aab','aaab','a'*12+'b','a{2}b','a{2,3}b'].map{|value|r.match?(value)}
end
p Regexp.new('\\Aa{(?#hi)2}b\\z').match?('aab')
p Regexp.new("\\Aa{#hi\n2}b\\z").match?("a{#hi\n2}b")
p Regexp.new("(?x:a{2,#hi\n100000}b)").match?('aab')
begin;Regexp.new("(?x:a{2,#hi\n100001}b)");rescue RegexpError=>e;p e.class;end
`
    )
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '[true, false, false, false, false]\n[true, false, false, false, false]\n[true, true, false, false, false]\n[false, false, true, false, false]\n[true, true, false, false, false]\n[true, false, false, false, false]\n[true, true, false, false, false]\n[false, false, false, true, false]\n[false, false, false, true, false]\n[false, false, false, false, true]\n[false, false, false, true, false]\ntrue\ntrue\ntrue\nRegexpError\n',
    uncaughtException: undefined,
  });
});

test('Literal interval tokens recognize comments before matching', () => {
  expect(
    run(String.raw`p /(?x:a{#hi
2}b)/.match?("aab")
p /(?x:a{2,#hi
3}b)/.match?("aaab")`)
  ).toMatchObject({ kind: 'executed', stdout: 'true\ntrue\n', uncaughtException: undefined });
});
