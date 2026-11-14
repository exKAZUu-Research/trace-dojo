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

test('exit handler exceptions supersede the main exception', () => {
  expect(run('at_exit { raise "handler" }; raise "main"')).toMatchObject({
    uncaughtException: 'handler (RuntimeError)',
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
