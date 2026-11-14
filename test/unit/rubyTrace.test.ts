import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { traceProgram } from '../../src/interpreter/program';
import type { TraceItem } from '../../src/problems/trace';

// The interpreter's clock stands still in these tests, so that the program, not the load of the host, decides each one.
beforeEach(() => {
  vi.spyOn(performance, 'now').mockReturnValue(0);
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** The programs of the two languages place their statements on different lines, so their steps compare without them. */
const withoutLines = (items: TraceItem[]): unknown[] =>
  items.map(({ line, callLines, ...item }) => ({ ...item, callDepth: callLines.length }));

const rubyTrace = (program: string): TraceItem[] => traceProgram('ruby', program, program).traceItems;

test('Struct, Data and value objects remain visible in the variable trace', () => {
  const program =
    'S=Struct.new(:a)\nD=Data.define(:x)\ns=S.new(1)\nd=D.new(2)\nr=1/3r\nt=Time.utc(2024)\nre=/a/\nm=/a(b)/.match("ab")\np s.a\n';
  const last = rubyTrace(program).at(-1);
  expect(last?.referenceVars).toMatchObject({
    s: { kind: 'object', entries: { a: { kind: 'value', value: 1 } } },
    d: { kind: 'object', entries: { x: { kind: 'value', value: 2 } } },
    r: { kind: 'value', value: '(1/3)' },
    t: { kind: 'value', value: '2024-01-01 00:00:00 UTC' },
    re: { kind: 'value', value: '/a/' },
    m: { kind: 'value', value: '#<MatchData "ab" 1:"b">' },
  });
});

test('user methods sharing declaration names keep atomic call steps', () => {
  for (const name of ['private', 'include']) {
    const program = `class A\n def ${name} # atomic\n  $x=1\n end\n def go\n  ${name}\n end\nend\nA.new.go`;
    const trace = rubyTrace(program);
    expect(trace.some((item) => item.line === 6 && item.vars.$x === 1)).toBe(true);
  }
});

test('class literal initializers trace reopened operator effects', () => {
  const program = 'class Integer\n def +(x) # atomic\n  $g=7\n end\nend\nclass C\n Y=1\n X=1+2\nend';
  expect(rubyTrace(program).some((item) => item.line === 8 && item.vars.$g === 7)).toBe(true);
});

test('allocated Float values remain visible in traces', () => {
  const program = 'a=Float::MAX;b=[Float::INFINITY]';
  const trace = traceProgram('ruby', program, program);
  expect(trace.finalVars.a).toBe(Number.MAX_VALUE);
  expect(trace.finalVars.b).toEqual([Number.POSITIVE_INFINITY]);
  expect(trace.traceItems.at(-1)?.referenceVars.b).toMatchObject({
    kind: 'array',
    entries: { 0: { kind: 'value', value: Number.POSITIVE_INFINITY } },
  });
});

test('values_at keeps earlier Turtle selections reachable through later conversions', () => {
  const program = 'class I;def to_int;$a.clear;x=1;0;end;end;$a=[Turtle.new];b=$a.values_at(0,I.new)';
  expect(traceProgram('ruby', program, program).finalTurtles).toHaveLength(1);
});

test('Array conversion results stay reachable during transpose and product', () => {
  const transpose =
    'class A;def to_ary;[Turtle.new];end;end;class B;def to_ary;x=1;[1];end;end;a=[A.new,B.new].transpose';
  expect(traceProgram('ruby', transpose, transpose).finalTurtles).toHaveLength(1);
  const product =
    'class A;def to_ary;[Turtle.new];end;end;class B;def to_ary;x=1;[1];end;end;a=[1].product(A.new,B.new)';
  expect(traceProgram('ruby', product, product).finalTurtles).toHaveLength(1);
});

test('transpose snapshots earlier row values before later conversions', () => {
  const program = 'class B;def to_ary;$r[0]=nil;q=1;[1];end;end;$r=[Turtle.new];a=[$r,B.new].transpose';
  expect(traceProgram('ruby', program, program).finalTurtles).toHaveLength(1);
});

test('anonymous class instances retain class Turtles', () => {
  const program = 'c=Class.new;c::X=Turtle.new;o=c.new;c=nil;x=1;t=o.class::X;t.forward';
  expect(traceProgram('ruby', program, program).finalTurtles).toMatchObject([{ y: 1 }]);
});

test('for-loop indexed receivers stay reachable through index evaluation', () => {
  const program =
    'class P;def initialize;@t=Turtle.new;end;def []=(i,v);$p=self;@t.forward;end;end;def recv;P.new;end;def idx;x=1;0;end;for recv[idx] in [1];end';
  expect(traceProgram('ruby', program, program).finalTurtles).toMatchObject([{ y: 1 }]);
});

test('boxed Float loop values record binding steps', () => {
  const program = '[Float::MAX,Float::MAX].each do |x|\nend';
  const items = traceProgram('ruby', program, program).traceItems;
  expect(items.filter((item) => item.vars.x === Number.MAX_VALUE)).toHaveLength(2);
});

test('Array combination snapshots keep later Turtles reachable', () => {
  const program = 'a=[1,Turtle.new];a.permutation(1){|x|a.clear if x[0]==1;$v=x[0]}';
  expect(traceProgram('ruby', program, program).finalTurtles).toHaveLength(1);
});

test('random selection snapshots remain reachable during custom draws', () => {
  const program = 'class R;def rand(n);$a.clear;x=1;0;end;end;$a=[1,Turtle.new];b=$a.shuffle(random:R.new)';
  expect(traceProgram('ruby', program, program).finalTurtles).toHaveLength(1);
});

test('Hash constructors and selections retain pending Turtles', () => {
  const constructor =
    'class K;def hash;x=1;0;end;end;class A;def to_ary;[[K.new,1],[:b,Turtle.new]];end;end;h=Hash[A.new]';
  expect(traceProgram('ruby', constructor, constructor).finalTurtles).toHaveLength(1);
  const lookup = '$h={a:Turtle.new};$h.default_proc=proc{|h,k|h.clear;x=1;nil};a=$h.values_at(:a,:b)';
  expect(traceProgram('ruby', lookup, lookup).finalTurtles).toHaveLength(1);
});

test('Hash callback results remain reachable during later entries', () => {
  const program = 'h={a:1,b:2};a=h.to_h{|k,v|if k==:a;[Turtle.new,1];else;x=1;[:b,2];end}';
  expect(traceProgram('ruby', program, program).finalTurtles).toHaveLength(1);
});

test('uniq roots the selected value while its key is hashed', () => {
  const program = 'class K;def hash;x=1;0;end;end;a=[Turtle.new,2];b=a.uniq{|x|a.clear;K.new}';
  expect(traceProgram('ruby', program, program).finalTurtles).toHaveLength(1);
});

test('Array intersection roots pending values during key hashing', () => {
  const program =
    'class K;def hash;$a.clear;$b.clear;q=1;0;end;end;$a=[Turtle.new,1]+Array.new(20,1);$b=[$a[0],K.new]+Array.new(20,9);c=$a.intersection($b)';
  expect(traceProgram('ruby', program, program).finalTurtles).toHaveLength(1);
});

test('Array difference roots pending values during key hashing', () => {
  const program = 'class K;def hash;$a.clear;q=1;0;end;end;$a=[Turtle.new,K.new]+Array.new(20,1);b=$a-Array.new(20,9)';
  expect(traceProgram('ruby', program, program).finalTurtles).toHaveLength(1);
});

test('Array union roots pending values during eql callbacks', () => {
  const program = 'class K;def eql?(x);$a.clear;q=1;false;end;end;$a=[Turtle.new(0,0),K.new,Turtle.new(1,0)];b=$a|[]';
  expect(traceProgram('ruby', program, program).finalTurtles).toHaveLength(2);
});

test('implicit super roots converted keyword rests while copying', () => {
  const program =
    'class K;def hash;q=1;0;end;end;class X;def to_hash;{K.new=>1,t:Turtle.new};end;end;class A;def f(**x);$v=x;end;end;class B<A;def f(**x);x=X.new;super;end;end;B.new.f';
  expect(traceProgram('ruby', program, program).finalTurtles).toHaveLength(1);
});

test('Enumerable reductions root retained accumulator values', () => {
  const injected = 'class E;include Enumerable;def each;yield Turtle.new;q=1;yield 2;end;end;x=E.new.inject{|a,b|a}';
  expect(traceProgram('ruby', injected, injected).finalTurtles).toHaveLength(1);
  const summed =
    'class B;def initialize;@t=Turtle.new;end;def +(x);self;end;end;class E;include Enumerable;def each;yield 1;q=1;yield 2;end;end;x=E.new.sum(B.new)';
  expect(traceProgram('ruby', summed, summed).finalTurtles).toHaveLength(1);
});

test('Enumerable reverse_each roots its collected snapshot during callbacks', () => {
  const program =
    'class E;include Enumerable;def each;yield Turtle.new;yield 2;end;end;t=nil;E.new.reverse_each{|v|q=1;t=v if v.is_a?(Turtle)}';
  expect(traceProgram('ruby', program, program).finalTurtles).toHaveLength(1);
});

test('Enumerable minmax roots both pending candidates during comparisons', () => {
  const program =
    'class P;attr_reader :n;def initialize(n,t=false);@n=n;@t=Turtle.new if t;end;end;class E;include Enumerable;def each;yield P.new(0);yield P.new(5);yield P.new(2);yield P.new(8,true);end;end;x=E.new.minmax{|a,b|q=1;a.n<=>b.n}';
  expect(traceProgram('ruby', program, program).finalTurtles).toHaveLength(1);
});

test('Enumerable slice_before roots the pending boundary element', () => {
  const program =
    'class E;include Enumerable;def each;yield 1;yield Turtle.new;end;end;x=E.new.slice_before{|v|true}.map{|a|q=1;a}';
  expect(traceProgram('ruby', program, program).finalTurtles).toHaveLength(1);
});

test('Array minmax roots its first result through the second traversal', () => {
  const program =
    'class P;attr_reader :n;def initialize(n,t=false);@n=n;@t=Turtle.new if t;end;def <=>(o);$c+=1;if $c==4;$a.clear;q=1;end;@n<=>o.n;end;end;$c=0;$a=[P.new(0,true),P.new(1),P.new(2)];x=$a.minmax';
  expect(traceProgram('ruby', program, program).finalTurtles).toHaveLength(1);
});

test('Hash slice and except root results through later key callbacks', () => {
  const slice =
    'class K;def hash;if $go;$h.clear;q=1;end;0;end;end;k=K.new;$go=false;$h={a:Turtle.new,k=>2};$go=true;x=$h.slice(:a,k)';
  expect(traceProgram('ruby', slice, slice).finalTurtles).toHaveLength(1);
  const except =
    'class K;def hash;if $go;$h.clear;q=1;end;0;end;end;k=K.new;$go=false;$h={a:Turtle.new,k=>2};$go=true;x=$h.except(k)';
  expect(traceProgram('ruby', except, except).finalTurtles).toHaveLength(1);
});

test('custom Range reverse_each roots generated elements during callbacks', () => {
  const program =
    'class A;attr_reader :n;def initialize(n,t=false);@n=n;@t=Turtle.new if t;end;def <=>(o);n<=>o.n;end;def succ;A.new(n+1,n==0);end;end;x=[];(A.new(0)..A.new(2)).reverse_each{|v|q=1;x<<v}';
  expect(traceProgram('ruby', program, program).finalTurtles).toHaveLength(1);
});

test('Array delete roots its last match during later comparisons', () => {
  const program =
    'class T<Turtle;def ==(x);true;end;end;class K;def ==(x);$a.clear;q=1;false;end;end;$a=[T.new,K.new];x=$a.delete(:x)';
  expect(traceProgram('ruby', program, program).finalTurtles).toHaveLength(1);
});

test('Set flatten roots pending members through subclass insertion callbacks', () => {
  const program =
    'class S<Set;def add(x);if $go;$s.clear;q=1;end;super;end;end;$s=S[1,Turtle.new];$go=true;x=$s.flatten';
  expect(traceProgram('ruby', program, program).finalTurtles).toHaveLength(1);
});

test('Enumerable group_by roots pending values while hashing keys', () => {
  const program = 'class K;def hash;q=1;0;end;end;a=[Turtle.new,2];h=a.group_by{|x|a.clear;K.new}';
  expect(traceProgram('ruby', program, program).finalTurtles).toHaveLength(1);
});

test('Hash group_by roots pending entry pairs while hashing group keys', () => {
  for (const program of [
    'class K;def hash;q=1;0;end;end;h={Turtle.new=>1};groups=h.group_by{|x|h.clear;K.new}',
    'class K;def hash;$h.clear;q=1;0;end;end;$h={a:Turtle.new};groups=$h.group_by{|x|K.new}',
  ])
    expect(traceProgram('ruby', program, program).finalTurtles).toHaveLength(1);
});

test('Set classify roots pending members while hashing keys', () => {
  const program = 'class K;def hash;q=1;0;end;end;s=Set[Turtle.new,2];h=s.classify{|x|s.clear;K.new}';
  expect(traceProgram('ruby', program, program).finalTurtles).toHaveLength(1);
});

test('Array concat roots early conversion results', () => {
  const program =
    'class A;def to_ary;[Turtle.new];end;end;class B;def to_ary;q=1;[];end;end;a=[];a.concat(A.new,B.new)';
  expect(traceProgram('ruby', program, program).finalTurtles).toHaveLength(1);
});

test('pending expression values remain visible in Turtle traces', () => {
  const programs = [
    'def v;x=1;42;end;h={Turtle.new=>v}',
    'class P;def initialize(x);@t=Turtle.new(x,0);end;def <=>(o);0;end;end;r=P.new(0)..P.new(1)',
    'class P;def initialize;@t=Turtle.new;end;def x=(v);$t=@t;@t.forward;end;end;def v;x=1;42;end;P.new.x=v',
  ];
  expect(programs.map((program) => traceProgram('ruby', program, program).finalTurtles.length)).toEqual([1, 2, 1]);
});

test('a Hash captured by to_proc remains reachable in Turtle traces', () => {
  const program = 'h={Turtle.new=>1};f=h.to_proc;h=nil;x=1';
  expect(traceProgram('ruby', program, program).finalTurtles).toHaveLength(1);
});

test('curried Proc captures remain reachable in Turtle traces', () => {
  const program = 'f=->(t,x){t.forward};c=f.curry.call(Turtle.new);f=nil;x=1;c.call(2)';
  expect(traceProgram('ruby', program, program).finalTurtles).toMatchObject([{ y: 1 }]);
});

test('byte-bearing class literals record the same steps as text literals', () => {
  const ordinary = rubyTrace('class C\n X="a"\nend').map(({ line }) => line);
  const escaped = rubyTrace(String.raw`class C
 X="\xFF"
end`).map(({ line }) => line);
  expect(escaped).toEqual(ordinary);
});

test.each([
  ['method', 'def f(x)\n marker = 1\nend\nf(begin\n  3\nend)', [4]],
  ['constructor', 'class C\n def initialize(x)\n  marker = 1\n end\nend\nC.new(begin\n  3\nend)', [6]],
  [
    'super',
    'class A\n def f(x)\n  marker = 1\n end\nend\nclass B < A\n def f(x)\n  super(begin\n   3\n  end)\n end\nend\nB.new.f(1)',
    [13, 8],
  ],
  ['yield', 'def f\n yield(begin\n  3\n end)\nend\nf do |x|\n marker = 1\nend', [6, 2]],
])('%s call row survives argument statements', (_name, program, expected) => {
  expect(rubyTrace(program).find((item) => item.vars.marker === 1)?.callLines).toEqual(expected);
});

test('a recursive Array Hash key remains traceable', () => {
  const program = 'a=[]; a << a; h={}; h[a]=1; p h.size';
  expect(traceProgram('ruby', program, program).stdout).toBe('1\n');
});

test('Hash trace retains a __proto__ key', () => {
  const program = 'h={__proto__:1,x:2}; p h';
  const item = traceProgram('ruby', program, program).traceItems.find((trace) => 'h' in trace.referenceVars);
  const node = item?.referenceVars.h;
  expect(node?.kind).toBe('object');
  if (node?.kind === 'object') expect(Object.hasOwn(node.entries, '__proto__')).toBe(true);
});

test('Turtles accumulated by map stay visible through later block steps', () => {
  const program = `ts = [1, 3].map do |x|
  t = Turtle.new(x, 0)
  t
end
ts.each { |t| t.forward }`;
  expect(traceProgram('ruby', program, program).finalTurtles).toMatchObject([
    { x: 1, y: 1 },
    { x: 3, y: 1 },
  ]);
});

test('Turtles accumulated by transform_values stay visible through later block steps', () => {
  const program = `h = {a:1, b:3}.transform_values do |x|
  t = Turtle.new(x, 0)
  t
end
h.each_value { |t| t.forward }`;
  expect(traceProgram('ruby', program, program).finalTurtles).toMatchObject([
    { x: 1, y: 1 },
    { x: 3, y: 1 },
  ]);
});

/** Programs that behave alike in both languages, so Ruby must reproduce the Java interpreter's trace. */
test.each([
  {
    name: 'moves, turns, conditions, and while loops',
    java: `public class Main {
  public static void main(String[] args) {
    Turtle 亀 = new Turtle(2, 1, "R");
    int n = 0;
    while (n < 3) {
      if (n % 2 == 0) {
        亀.前に進む();
      } else {
        亀.右を向く();
      }
      n++;
    }
    亀.後に戻る();
  }
}`,
    ruby: `亀 = Turtle.new(2, 1, "R")
n = 0
while n < 3
  if n % 2 == 0
    亀.前に進む
  else
    亀.右を向く
  end
  n += 1
end
亀.後に戻る`,
  },
  {
    name: 'methods whose calls show their steps, and a method whose return value is stored',
    java: `public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle();
    int x = twice(1);
    move(t);
    t.右を向く();
    move(t);
  }
  static int twice(int a) {
    return a * 2;
  }
  static void move(Turtle t) {
    t.前に進む();
    t.前に進む();
  }
}`,
    ruby: `def twice(a)
  return a * 2
end

def move(t)
  t.前に進む
  t.前に進む
end

t = Turtle.new
x = twice(1)
move(t)
t.右を向く
move(t)`,
  },
  {
    name: 'exceptions raised in a method and rescued by the caller',
    java: `public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle();
    try {
      walk(t);
      t.右を向く();
    } catch (IllegalArgumentException e) {
      t.左を向く();
    }
  }
  static void walk(Turtle t) {
    t.前に進む();
    throw new IllegalArgumentException();
  }
}`,
    ruby: `def walk(t)
  t.前に進む
  raise ArgumentError
end

t = Turtle.new
begin
  walk(t)
  t.右を向く
rescue ArgumentError => e
  t.左を向く
end`,
  },
])('$name', ({ java, ruby }) => {
  expect(withoutLines(rubyTrace(ruby))).toEqual(withoutLines(traceProgram('java', java, java).traceItems));
});

test('a block an iterator calls binds its parameter as a step, and the block shows the variables around it', () => {
  const items = rubyTrace(`t = Turtle.new
count = 0
2.times do |i|
  t.前に進む
  count += i
end`);
  expect(items.map(({ line, vars }) => [line, vars])).toEqual([
    [0, {}],
    [1, {}],
    [2, { count: 0 }],
    [3, { count: 0, i: 0 }],
    [4, { count: 0, i: 0 }],
    [5, { count: 0, i: 0 }],
    [3, { count: 0, i: 1 }],
    [4, { count: 0, i: 1 }],
    [5, { count: 1, i: 1 }],
  ]);
});

test('the last expression of a method or block records no step when its value is used, as a return does', () => {
  const items = rubyTrace(`def double(a)
  a * 2
end

x = double(3)
y = [1, 2].map { |v| v + x }`);
  expect(items.map(({ line, vars }) => [line, vars])).toEqual([
    [0, {}],
    [5, { x: 6 }],
    [6, { x: 6, v: 1 }],
    [6, { x: 6, v: 2 }],
    [6, { x: 6, y: [7, 8] }],
  ]);
});

test('# atomic makes a call to the method one step', () => {
  const items = rubyTrace(`def walk(t, n) # atomic
  n.times do |i|
    t.前に進む
  end
end

t = Turtle.new
walk(t, 3)
t.右を向く`);
  expect(items.map(({ line }) => line)).toEqual([0, 7, 8, 9]);
  expect(items[2].turtles).toEqual([{ x: 0, y: 3, color: '#', dir: 'N' }]);
});

test('a turtle in an array literal stays while the rest of the literal runs, and vanishes once unreachable', () => {
  const items = rubyTrace(`class Walker
  def initialize(x)
    @t = Turtle.new(x, 0)
  end
end

ws = [Walker.new(1), Walker.new(3)]
ws = nil`);
  expect(items.map(({ turtles }) => turtles.length)).toEqual([0, 1, 2, 0]);
});

test('instance, class, and global variables show as Ruby names them', () => {
  const items = rubyTrace(`class Counter
  @@total = 0

  def initialize
    @count = 1
    @@total += 1
  end
end

$runs = 1
c = Counter.new`);
  // The assignment of the new object records no step of its own, since the constructor's steps show what it did.
  expect(items.map(({ vars }) => vars)).toEqual([
    {},
    { 'Counter.@@total': 0, $runs: 1 },
    { '@count': 1, 'Counter.@@total': 0, $runs: 1 },
    { '@count': 1, 'Counter.@@total': 1, $runs: 1 },
  ]);
});

test('a pattern binds its variables without a step of its own, as a condition records none', () => {
  const items = rubyTrace(`t = Turtle.new
moves = [[:forward, 2], [:turn]]
moves.each do |move|
  case move
  in [:forward, n]
    n.times { t.前に進む }
  in [:turn]
    t.右を向く
  end
end`);
  expect(items.map(({ line, vars }) => [line, vars.n])).toEqual([
    [0, undefined],
    [1, undefined],
    [2, undefined],
    [6, 2],
    [6, 2],
    [8, undefined],
  ]);
  expect(items.at(-1)?.turtles).toEqual([{ x: 0, y: 2, color: '#', dir: 'E' }]);
});
test('Enumerator with_index preserves direct each_with_index steps', () => {
  const traces = ['each_with_index', 'each.with_index'].map((method) =>
    rubyTrace(`t = Turtle.new
[1, 2].${method} do |x, i|
  t.forward
end`).map(({ line, vars, turtles }) => ({ line, vars, y: turtles[0]?.y }))
  );
  expect(traces[1]).toEqual(traces[0]);
});

test('shared Array keys have bounded trace labels', () => {
  const program = `def mk # atomic
  a = [1]
  20.times { a = [a, a] }
  a
end
h = { mk => 1 }`;
  expect(JSON.stringify(rubyTrace(program)).length).toBeLessThan(100_000);
});

test('collection builders keep Turtles alive across callbacks', () => {
  for (const program of [
    'h=[1,3].group_by do |x|\n Turtle.new(x,0)\nend\nh.keys.each { |t| t.forward }',
    'h=[1,3].chunk do |x|\n Turtle.new(x,0)\nend\nts=[]\nh.each { |k,v| ts << k; k.forward }',
  ]) {
    const items = rubyTrace(program);
    expect(items.some(({ turtles }) => turtles.length === 2 && turtles.every(({ y }) => y === 1))).toBe(true);
  }
});

test('positional Turtles stay alive while keyword arguments evaluate', () => {
  const items = rubyTrace(
    'def f(*ts,k:)\n ts.each { |t| t.forward }\nend\nf(Turtle.new(1,0),Turtle.new(3,0),k: [1].map { |x| x })'
  );
  expect(items.some(({ turtles }) => turtles.length === 2 && turtles.every(({ y }) => y === 1))).toBe(true);
});

test('Array to_h and chunk Enumerators retain accumulated Turtles through callbacks', () => {
  const programs = [
    'h=[1,3].to_h do |x|\n [x,Turtle.new(x,0)]\nend\nh.values.each { |t| t.forward }',
    ...['chunk_while { |a,b| false }', 'slice_when { |a,b| true }'].map(
      (method) =>
        `class C\n include Enumerable\n def each\n  yield Turtle.new(1,0)\n  yield Turtle.new(3,0)\n end\nend\nts=[]\nC.new.${method}.each do |c|\n ts << c[0]\n c[0].forward\nend\nts.each { |t| t.forward }`
    ),
  ];
  expect(
    rubyTrace(programs[0])
      .at(-1)
      ?.turtles.map(({ x, y }) => [x, y])
  ).toEqual([
    [1, 1],
    [3, 1],
  ]);
  for (const program of programs.slice(1))
    expect(
      rubyTrace(program)
        .at(-1)
        ?.turtles.map(({ x, y }) => [x, y])
    ).toEqual([
      [1, 2],
      [3, 2],
    ]);
});

test('Hash insertion keeps pending values alive through custom hash callbacks', () => {
  for (const [receiver, positions] of [
    ['[1,3]', [1, 3]],
    ['(1..2)', [1, 2]],
  ] as const) {
    const program = `class Key\n def hash\n  x=1\n  0\n end\nend\nh=${receiver}.to_h do |x|\n [Key.new,Turtle.new(x,0)]\nend\nh.values.each { |t| t.forward }`;
    expect(
      rubyTrace(program)
        .at(-1)
        ?.turtles.map(({ x, y }) => [x, y])
    ).toEqual(positions.map((x) => [x, 1]));
  }
});

test('a multiline call records its expression line', () => {
  const items = rubyTrace('def f\n  x = 1\n  0\nend\nv = (\n  f\n)');
  expect(items.find(({ vars }) => vars.x === 1)?.callLines).toEqual([6]);
});

test('Enumerable collectors retain yielded Turtles through later callbacks', () => {
  for (const call of [
    'sort_by { 1 }',
    'take(2)',
    'take_while { true }',
    'drop_while { false }',
    'sort { 0 }',
    'uniq',
  ]) {
    const program = `class E; include Enumerable; def each; yield Turtle.new(1,0); x=1; yield Turtle.new(2,0); end; end; a=E.new.${call}`;
    expect(traceProgram('ruby', program, program).finalTurtles.map(({ x, y }) => [x, y])).toEqual([
      [1, 0],
      [2, 0],
    ]);
  }
});

test('Enumerable grouping and extrema retain values through source steps', () => {
  for (const call of [
    'each_slice(2).to_a',
    'each_cons(2).to_a',
    'zip([])',
    'tally',
    'group_by { 1 }',
    'min_by(2) { 1 }',
  ]) {
    const program = `class E; include Enumerable; def each; yield Turtle.new(1,0); x=1; yield Turtle.new(2,0); end; end; a=E.new.${call}`;
    expect(traceProgram('ruby', program, program).finalTurtles.map(({ x, y }) => [x, y])).toEqual([
      [1, 0],
      [2, 0],
    ]);
  }
  const program =
    'class E; include Enumerable; def each; yield Turtle.new(1,0); x=1; yield Turtle.new(2,0); end; end; a=E.new.min_by { 1 }';
  expect(traceProgram('ruby', program, program).finalTurtles.map(({ x, y }) => [x, y])).toEqual([[1, 0]]);
});

test('trace expansion stays bounded for shared Array graphs', () => {
  const program = 'def mk # atomic\n a=[1]\n 23.times { a=[a,a] }\n a\nend\nx=mk';
  expect(() => traceProgram('ruby', program, program)).toThrow('Execution limit exceeded: trace');
});

test('large flat Arrays remain visible in final trace variables', () => {
  const program = 'a=Array.new(2001,1)';
  const values = traceProgram('ruby', program, program).finalVars.a;
  expect(Array.isArray(values)).toBe(true);
  expect((values as unknown[]).length).toBe(2001);
  expect((values as unknown[]).at(-1)).toBe(1);
  const display = traceProgram('ruby', program, program).traceItems.at(-1)?.referenceVars.a;
  expect(display).toMatchObject({ kind: 'array', entries: { '1999': { kind: 'value', value: '…' } } });
});

test('rescue selection keeps the active exception and its Turtle reachable', () => {
  const program =
    'class E<StandardError;def initialize;@t=Turtle.new;end;end;def c;x=1;E;end;begin;raise E.new;rescue c=>e;$saved=e;end';
  expect(traceProgram('ruby', program, program).finalTurtles).toHaveLength(1);
});

test('super arguments stay reachable while evaluating a later block argument', () => {
  const program =
    'class A;def f(x);$v=x;end;end;class B<A;def b;q=1;proc{};end;def f;super(Turtle.new,&b);end;end;B.new.f';
  expect(traceProgram('ruby', program, program).finalTurtles).toHaveLength(1);
});

test('block arguments stay reachable while evaluating parameter defaults', () => {
  for (const program of [
    'def f;yield Turtle.new;end;f{|a=(q=1),b|$v=b}',
    'def f;yield k:Turtle.new;end;f{|a=(q=1),k:|$v=k}',
  ])
    expect(traceProgram('ruby', program, program).finalTurtles).toHaveLength(1);
});

test('puts keeps converted Array elements reachable through earlier to_s callbacks', () => {
  const program =
    'class X;def to_s;q=1;"x";end;end;class T<Turtle;def to_s;$saved=self;"t";end;end;class W;def to_ary;[X.new,T.new];end;end;puts W.new';
  expect(traceProgram('ruby', program, program).finalTurtles).toHaveLength(1);
});

test('join keeps converted Array elements reachable through earlier to_s callbacks', () => {
  const program =
    'class X;def to_s;q=1;"x";end;end;class T<Turtle;def to_s;$saved=self;"t";end;end;class W;def to_ary;[X.new,T.new];end;end;[W.new].join';
  expect(traceProgram('ruby', program, program).finalTurtles).toHaveLength(1);
});

test('flatten keeps accumulated elements reachable during later conversions', () => {
  for (const method of ['flatten', 'flatten!']) {
    const program = `class A;def to_ary;[Turtle.new];end;end;class B;def to_ary;x=1;[];end;end;a=[A.new,B.new].${method}`;
    expect(traceProgram('ruby', program, program).finalTurtles).toHaveLength(1);
  }
});

test('Set symmetric difference roots a temporary operand during source callbacks', () => {
  const program = 'class E;include Enumerable;def each;yield Turtle.new;x=1;yield 2;end;end;s=Set[] ^ E.new';
  expect(traceProgram('ruby', program, program).finalTurtles).toHaveLength(1);
});

test('ArithmeticSequence keeps keyword arguments reachable', () => {
  const program =
    'class A;def initialize;@t=Turtle.new;end;def coerce(x);$v=@t;[x,3];end;end;e=1.step(to:A.new);x=1;e.first';
  expect(traceProgram('ruby', program, program).finalTurtles).toHaveLength(1);
});

test('Range first keeps collected successors reachable', () => {
  const program =
    'class P;attr_reader :n;def initialize(n);@n=n;@t=Turtle.new(n,0);end;def <=>(o);n<=>o.n;end;def succ;q=1;P.new(n+1);end;end;a=(P.new(0)..P.new(4)).first(4)';
  expect(traceProgram('ruby', program, program).finalTurtles).toHaveLength(4);
});

test('for-loop target evaluation roots the yielded value', () => {
  const program =
    'class E;def each;yield Turtle.new;end;end;class A;attr_accessor :x;end;$a=A.new;def recv;q=1;$a;end;for recv.x in E.new;end';
  expect(traceProgram('ruby', program, program).finalTurtles).toHaveLength(1);
});

test('converted Hash sources keep later Turtle values alive during insertion', () => {
  for (const operation of ['h={**A.new}', 'h={}.merge(A.new)']) {
    const program = `class K; def hash; x=1; 0; end; end; class A; def to_hash; {K.new=>1, 2=>Turtle.new}; end; end; ${operation}`;
    expect(traceProgram('ruby', program, program).finalTurtles).toHaveLength(1);
  }
});

test('multiple assignment roots pending values through earlier setters', () => {
  for (const assignment of ['a.x,b=0,Turtle.new', 'a.x,(b,c)=0,[Turtle.new,1]']) {
    const program = `class A; def x=(v); q=1; end; end; a=A.new; ${assignment}`;
    expect(traceProgram('ruby', program, program).finalTurtles).toHaveLength(1);
  }
});

test('operator assignment and case root earlier operands through later expressions', () => {
  const operator =
    'class P; def initialize; @t=Turtle.new; end; def +(x); self; end; end; class A; def x; P.new; end; def x=(v); $p=v; end; end; def f; x=1; 1; end; A.new.x += f';
  expect(traceProgram('ruby', operator, operator).finalTurtles).toHaveLength(1);
  const match = 'class P; def ===(x); $t=x; true; end; end; def f; x=1; P.new; end; case Turtle.new; when f; end';
  expect(traceProgram('ruby', match, match).finalTurtles).toHaveLength(1);
});

test('ensure keeps pending return and break values reachable', () => {
  const returned = 'def f; begin; return Turtle.new; ensure; x=1; end; end; t=f';
  expect(traceProgram('ruby', returned, returned).finalTurtles).toHaveLength(1);
  const broken = 't=loop do; begin; break Turtle.new; ensure; x=1; end; end';
  expect(traceProgram('ruby', broken, broken).finalTurtles).toHaveLength(1);
});

test('Enumerable cycle retains cached Turtles through replay', () => {
  const program =
    'class E; include Enumerable; def each; yield 1; yield Turtle.new; end; end; $n=0; E.new.cycle(2) { |x| $n+=1; $saved=x if $n==4 }';
  expect(traceProgram('ruby', program, program).finalTurtles).toHaveLength(1);
});

test('zip retains earlier converted inputs during later conversions', () => {
  const program =
    'class A; def to_ary; [Turtle.new]; end; end; class B; def to_ary; x=1; [2]; end; end; v=[1].zip(A.new,B.new)';
  expect(traceProgram('ruby', program, program).finalTurtles).toHaveLength(1);
});

test('trace variables keep special local names as own properties', () => {
  for (const value of ['42', '[1,2]']) {
    const program = `__proto__=${value}`;
    const trace = traceProgram('ruby', program, program);
    expect(Object.hasOwn(trace.finalVars, '__proto__')).toBe(true);
    expect(Object.hasOwn(trace.traceItems.at(-1)?.referenceVars ?? {}, '__proto__')).toBe(value.startsWith('['));
  }
});

test('suspended external iterators and installed method blocks retain reachable Turtles', () => {
  const suspended =
    'e=Enumerator.new do |y|\n t=Turtle.new\n y<<nil\n t.forward\n y<<nil\nend\ne.next\nx=1\ne.next\nx=2';
  expect(traceProgram('ruby', suspended, suspended).finalTurtles).toHaveLength(1);
  const installed = 't=Turtle.new;Object.define_method(:keep){t};x=1';
  expect(traceProgram('ruby', installed, installed).finalTurtles).toHaveLength(1);
});

test('chained external iterators retain Turtles in suspended frames', () => {
  const program =
    'class C\ninclude Enumerable\ndef each\nt=Turtle.new\nyield nil\nt.forward\nyield nil\nend\nend\ne=C.new.chain([])\ne.next\nx=1\ne.next\nx=2';
  expect(traceProgram('ruby', program, program).finalTurtles).toHaveLength(1);
});

test('Struct trace nodes include instance variables beside members', () => {
  const program =
    'class Point < Struct.new(:x)\n def initialize(x); super(x); @label="origin"; end\nend\np=Point.new(1)\nputs p.x';
  expect(rubyTrace(program).at(-1)?.referenceVars).toMatchObject({
    p: { kind: 'object', entries: { x: { kind: 'value', value: 1 }, '@label': { kind: 'value', value: 'origin' } } },
  });
});

test('exit handlers keep captured turtles reachable through final recording', () => {
  const program = 'def setup\n t=Turtle.new\n at_exit { t.forward }\nend\nsetup\nx=1\n';
  const result = traceProgram('ruby', program, program);
  expect(result.finalTurtles).toMatchObject([{ x: 0, y: 1 }]);
});

test('Method#to_proc retains its bound receiver in trace roots', () => {
  const program = 'cb=Turtle.new.method(:forward).to_proc\nx=1\ncb.call';
  const result = traceProgram('ruby', program, program);
  expect(result.finalTurtles).toMatchObject([{ x: 0, y: 1 }]);
});

test('Lazy and Struct collectors retain earlier Turtle results', () => {
  for (const program of [
    'a=[1,2].lazy.map{|v|Turtle.new(v,0)}.force',
    'S=Struct.new(:a,:b);h=S.new(1,2).to_h{|k,v|[k,Turtle.new(v,0)]}',
  ]) {
    const result = traceProgram('ruby', program, program);
    expect(result.finalTurtles).toMatchObject([
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ]);
  }
});

test('pattern subjects stay rooted while pins run', () => {
  const program = 'def check; x=1; Array; end\ncase [Turtle.new]\nin ^(check) => a\n a[0].forward\nend';
  const result = traceProgram('ruby', program, program);
  expect(result.finalTurtles).toMatchObject([{ x: 0, y: 1 }]);
});

test('nested pattern callbacks retain pending deconstructed turtles', () => {
  for (const program of [
    'class A;def deconstruct;[Turtle.new(1,0),Turtle.new(2,0)];end;end;def check;x=1;Turtle;end;A.new=>[^(check)=>a,b];a.forward;b.forward',
    'class A;def deconstruct_keys(ks);{a:Turtle.new(1,0),b:Turtle.new(2,0)};end;end;def check;x=1;Turtle;end;A.new=>{a:^(check)=>a,b:b};a.forward;b.forward',
  ]) {
    expect(traceProgram('ruby', program, program).finalTurtles).toMatchObject([
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ]);
  }
  const acrossClauses =
    'class A;def deconstruct;[Turtle.new];end;end;class T;def self.===(o);x=1;true;end;end;case A.new;in [Integer];in T[t];t.forward;end';
  expect(traceProgram('ruby', acrossClauses, acrossClauses).finalTurtles).toMatchObject([{ x: 0, y: 1 }]);
  const failedMatch =
    'class A;def deconstruct_keys(ks);{a:Turtle.new};end;def inspect;@n=1;"A";end;end;begin;A.new=>{b:};rescue NoMatchingPatternKeyError=>e;t=e.matchee[:a];t.forward;end';
  expect(traceProgram('ruby', failedMatch, failedMatch).finalTurtles).toMatchObject([{ x: 0, y: 1 }]);
});

test('Lazy callbacks retain pending flattened and deduplicated turtles', () => {
  const flattened = 'a=[1].lazy.flat_map{|x|[Turtle.new(1,0),Turtle.new(2,0)]}.map{|t|t.forward;t}.force';
  expect(traceProgram('ruby', flattened, flattened).finalTurtles).toMatchObject([
    { x: 1, y: 1 },
    { x: 2, y: 1 },
  ]);
  const deduplicated = 'class K;def hash;q=1;0;end;end\na=[1].lazy.map{Turtle.new}.uniq{|t|K.new}.force';
  expect(traceProgram('ruby', deduplicated, deduplicated).finalTurtles).toMatchObject([{ x: 0, y: 0 }]);
});

test('exhausted Enumerator retains its StopIteration result', () => {
  const program =
    'e=Enumerator.new do |y|\n t=Turtle.new\n y << 1\n t\nend\ne.next\nbegin\n e.next\nrescue StopIteration\nend\nx=1\nbegin\n e.next\nrescue StopIteration => ex\n ex.result.forward\nend\n';
  expect(traceProgram('ruby', program, program).finalTurtles).toMatchObject([{ x: 0, y: 1 }]);
});

test('match globals retain their instance variables during trace collection', () => {
  const program = '/a/ =~ "a"\n$~.instance_variable_set(:@t,Turtle.new)\nx=1\n$~.instance_variable_get(:@t).forward\n';
  expect(traceProgram('ruby', program, program).finalTurtles).toMatchObject([{ x: 0, y: 1 }]);
});
