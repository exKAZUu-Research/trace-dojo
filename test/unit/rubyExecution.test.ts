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
