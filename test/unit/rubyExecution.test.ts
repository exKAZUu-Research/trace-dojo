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
  ['else without rescue', 'begin\n  1\nelse\n  2\nend'],
  ['a lowercase class name', 'class foo; end'],
  ['a command call as an operand', 'p 1 && p 2'],
  ['Unicode escape as a control operand', String.raw`p "\C-\u0041".bytes`],
  ['Unicode escape as a meta operand', String.raw`p "\M-\u0041".bytes`],
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
  ['Rational conversion', 'Rational(1, 2)', '有理数（Rational）は、この採点環境では使えません。'],
  ['Complex conversion', 'Kernel.Complex(1, 2)', '複素数（Complex）は、この採点環境では使えません。'],
  ['regexp match global', 'p $&', '正規表現のマッチの結果（$&）は、この採点環境では使えません。'],
  ['numbered regexp match global', 'p $2', '正規表現のマッチの結果（$2）は、この採点環境では使えません。'],
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

test('Array delete retains contents when an equality callback raises', () => {
  expect(
    run(
      'class X;def initialize(n);@n=n;end;def ==(v);raise "bad" if @n==2;true;end;end;$a=[X.new(1),X.new(2),3];begin;$a.delete(0);rescue;end;p $a.size'
    )
  ).toMatchObject({
    stdout: '3\n',
  });
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

test('shared container equality stays within the execution budget', () => {
  for (const comparison of ['a==b', 'a.eql?(b)']) {
    expect(run(`a=[1]; b=[1]; 24.times { a=[a,a]; b=[b,b] }; p ${comparison}`)).toMatchObject({
      kind: 'limitExceeded',
    });
  }
});

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
    'a=0;b=1;1000000.to_s(2).each_char{|c|x=a*(2*b-a);y=a*a+b*b;if c=="0";a=x;b=y;else;a=y;b=x+y;end};p a.gcd(b)';
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

test('invalid trailing Array elements and repeated rest targets fail before execution', () => {
  for (const source of ['p [a:1,2]', 'p [a:1,*[2]]', 'a,*b,*c=[1,2,3]', '[1].each{|(a,*b,*c)|p a}'])
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
