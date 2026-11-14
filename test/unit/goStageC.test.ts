import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test('generic functions and methods expand a multi-result argument exactly once', () => {
  const source = `package main
import "fmt"
var calls int
func pair() (int, int) { calls++; return 2, 3 }
func first[T any](a, b T) T { return a }
func sum[T interface{ ~int }](values ...T) T { var total T; for _, v := range values { total += v }; return total }
type Box struct{}
func (Box) First[T any](a, b T) T { return a }
func main() {
  fmt.Println(first(pair()), first[int](pair()), sum(pair()), Box{}.First(pair()), calls)
}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '2 2 5 2 4\n',
  });
});

test('goto, labels, and select follow terminating-statement rules', () => {
  const source = `package main
import "fmt"
func forever() int { select {} }
func jumps() int { goto L; L: goto L }
func fall(i int) int { switch i { case 0: goto L; L: fallthrough; default: return 8 } }
func choose(ch chan int) int { select { case value := <-ch: return value; default: return 7 } }
func labeled(n int) int {
outer:
  for {
    for i := 0; i < n; i++ { if i == 3 { continue outer }; return i }
    n++
  }
}
func main() { fmt.Println(choose(nil), labeled(1), fall(0)) }`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '7 0 8\n',
  });
  expect(
    executeProgram(
      'go',
      `package main
func invalid() int { L: for { for { break L } } }
func main() {}`
    )
  ).toMatchObject({ kind: 'compileError' });
});

test('constant-length array ranges omit unused source evaluation', () => {
  const source = `package main
import "fmt"
func main() {
  var pointer *[3]int
  for i := range *pointer { fmt.Print(i) }
  arrays := [1][2]int{}
  at := 9
  for i := range arrays[at] { fmt.Print(i) }
  fmt.Println()
}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '01201\n',
  });
});

test('promoted pointer method expressions belong to the embedding value method set', () => {
  const source = `package main
import "fmt"
type T struct{ N int }
func(t *T) Get() int { return t.N }
type S struct{ *T }
func main() { f := S.Get; fmt.Println(f(S{&T{7}})) }`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '7\n',
  });
});

test.each([
  'var x interface{~int};_=x',
  'var x []interface{~int};_=x',
  'var x map[string]interface{int|string};_=x',
  'var x struct{V interface{~int}};_=x',
])('type sets are constraint-only in every type position: %s', (declaration) => {
  const result = executeProgram('go', `package main\nfunc main(){${declaration}}`);
  expect(result.kind).toBe('compileError');
  if (result.kind === 'compileError')
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ row: 1, message: expect.stringContaining('型の制約にしか使えません') }),
    ]);
});

test.each(['type Number = interface{~int|~float64}', 'type Ordered interface{~int|~float64};type Number = Ordered'])(
  'constraint aliases remain valid declarations: %s',
  (alias) => {
    const source = `package main
import "fmt"
${alias}
func Sum[T Number](xs []T)T{var sum T;for _,x:=range xs{sum+=x};return sum}
func main(){fmt.Println(Sum([]int{1,2}),Sum([]float64{1.5,2.5}))}`;
    expect(executeProgram('go', source)).toMatchObject({
      kind: 'executed',
      stdout: '3 4\n',
      uncaughtException: undefined,
    });
    expect(executeProgram('go', `package main\n${alias}\nfunc main(){var value Number;_=value}`)).toMatchObject({
      kind: 'compileError',
    });
  }
);

test('constraint contexts do not allow type sets inside ordinary nested types', () => {
  expect(executeProgram('go', 'package main;func f[T ~[]interface{~int}](){};func main(){}')).toMatchObject({
    kind: 'compileError',
  });
});

test('range yield results may alias the predeclared bool', () => {
  const source =
    'package main;import "fmt";type B=bool;func seq(yield func()B){yield()};func main(){for range seq{fmt.Println("ok")}}';
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: 'ok\n',
    uncaughtException: undefined,
  });
});

test('invalid recursive aliases, constraints, spread calls, ranges and receive declarations produce diagnostics', () => {
  for (const body of [
    'func main(){_= [...]int{1.5:1}}',
    'func main(){_= [...]int{"s":1}}',
    'func main(){const k=1.5;_= [...]int{k:1}}',
    'type A=B;type B=A;func main(){}',
    'type A=[]A;func main(){}',
    'type A=map[int]A;func main(){}',
    'type A=func(A);func main(){}',
    'type A=interface{I};type I interface{M(A)};func main(){}',
    'type N interface{~int|int};func main(){}',
    'type A int;type N interface{~int|A};func main(){}',
    'type N interface{int|comparable};func main(){}',
    'type N interface{~any};func main(){}',
    'type N int;func f[T int](x T)T{return x};func g[T ~int](x T)T{return f(x)};func main(){_=g(N(1))}',
    'func f[T string](x T)T{return x};func g[T ~string](x T)T{return f(x)};func main(){}',
    'func main(){var i int;for i=range 3.0{}}',
    'func main(){var i int;for i=range 3+0i{}}',
    'func main(){ch:=make(chan int,1);ch<-1;select{case _:=<-ch:}}',
    'func main(){ch:=make(chan int,1);ch<-1;select{case _,_:=<-ch:}}',
    'func main(){ch:=make(chan int,1);ch<-1;select{case x,x:=<-ch:_=x}}',
    'func F[T,U any](x T)U{var z U;return z};func main(){f:=F[int];_=f}',
    'func main(){xs:=[]int{1};_=len(xs...)}',
    'func main(){xs:=[]int{1};copy(xs,xs...)}',
    'func main(){xs:=[]int{1};println(xs...)}',
    'func main(){xs:=[]int{1};defer println(xs...)}',
    'func main(){xs:=[]int{1};go println(xs...)}',
    'func main(){x:=make(chan<- chan int);_= <-x}',
  ])
    expect(executeProgram('go', 'package main;' + body)).toMatchObject({ kind: 'compileError' });
});

test('generic byte and channel operations retain element direction and assignment restrictions', () => {
  for (const body of [
    'type B byte;func main(){_=append([]B{},"x"...)}',
    'type B byte;func main(){copy([]B{0},"x")}',
    'func f[C ~chan int|~<-chan int](c C){c<-1};func main(){}',
    'func f[C ~chan int|~<-chan int](c C){close(c)};func main(){}',
    'func f[C ~chan int|~chan<- int](c C)int{return <-c};func main(){}',
    'func f[C ~chan int|~<-chan string](c C)int{return <-c};func main(){}',
    'func f[T ~[]int|~int]()T{return nil};func main(){}',
    'func f[T any]()T{return nil};func main(){}',
    'type N []int;func f[T ~[]int](x N)T{return x};func main(){}',
    'type N []int;func f[T ~[]int](x T)N{return x};func main(){}',
    'func f[T ~string|~[]byte](x T)[]byte{return x};func main(){}',
  ])
    expect(executeProgram('go', 'package main;' + body)).toMatchObject({ kind: 'compileError' });
});

test('unparenthesized channel chains use Go leftmost arrow association at every depth', () => {
  expect(
    executeProgram(
      'go',
      String.raw`package main;import "fmt";func main(){h:=make(chan<- chan<- chan int,1);h<-make(chan<- chan int);fmt.Println(len(h));var x0 chan<- chan<- chan int;fmt.Printf("%T\n",x0);var x1 chan<- chan<- chan<- int;fmt.Printf("%T\n",x1);var x2 chan chan<- chan<- chan int;fmt.Printf("%T\n",x2);var x3 <-chan<-chan<-chan int;fmt.Printf("%T\n",x3);var x4 chan<- <-chan<-chan int;fmt.Printf("%T\n",x4);var x5 chan<- chan<- chan<- chan int;fmt.Printf("%T\n",x5);var x6 chan<- chan<- chan<- chan<- chan int;fmt.Printf("%T\n",x6);var x7 chan<- (chan<- chan int);fmt.Printf("%T\n",x7);var x8 chan (chan<- <-chan int);fmt.Printf("%T\n",x8);var x9 chan /*a*/ <- /*b*/ chan /*c*/ <- chan int;fmt.Printf("%T\n",x9);var x10 chan<- chan<- chan (<-chan int);fmt.Printf("%T\n",x10);var x11 <-chan (chan<- chan<- chan int);fmt.Printf("%T\n",x11);}`
    )
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '1\nchan<- chan<- chan int\nchan<- chan<- chan<- int\nchan chan<- chan<- chan int\n<-chan <-chan <-chan int\nchan<- <-chan <-chan int\nchan<- chan<- chan<- chan int\nchan<- chan<- chan<- chan<- chan int\nchan<- chan<- chan int\nchan chan<- <-chan int\nchan<- chan<- chan int\nchan<- chan<- chan (<-chan int)\n<-chan chan<- chan<- chan int\n',
    uncaughtException: undefined,
  });
});

test('alias-only cycles and their dependents are invalid before structural type walks', () => {
  for (const body of [
    'type A=[2]A;func main(){var a A;_=a}',
    'type A=struct{x A};func main(){var a A;_=a}',
    'type A=[1]B;type B=[1]A;func main(){var a A;_=a}',
    'type A=struct{b B};type B=struct{a A};func main(){var a A;_=a}',
    'type A=[2]A;func main(){_=len(A{})}',
    'type A=[0]A;func main(){var a A;_=a}',
    'type A=[]struct{X A};func main(){var a A;_=a}',
    'type Z=struct{Good int;Bad *A};type A=[2]A;func main(){var z Z;_=z}',
  ])
    expect(executeProgram('go', 'package main;' + body)).toMatchObject({ kind: 'compileError' });
});

test('alias completion preserves named generic interface and map recursion', () => {
  expect(
    executeProgram(
      'go',
      'package main;import "fmt";type A=*G[int];type G[T any]struct{Next A;N T};type I=J;type J interface{M(I)};type S=struct{N B};type B=int;type K=map[Key]int;type Key struct{Next *K};func main(){var g G[int];g.Next=&G[int]{N:7};var i I;var k K;fmt.Println(g.Next.N,i==nil,S{4}.N,k==nil)}'
    )
  ).toMatchObject({ kind: 'executed', stdout: '7 true 4 true\n', uncaughtException: undefined });
});

test('type parameters cannot be constraints or union terms even through aliases', () => {
  for (const body of [
    'func f[T any,U T](x U){};func main(){}',
    'func f[T any,U interface{T|int}](x U){};func main(){}',
    'func f[T any,U interface{T}](x U){};func main(){}',
    'func f[T any,U interface{~T}](x U){};func main(){}',
    'func f[T any](){type A=T;type C interface{A|int}};func main(){}',
  ])
    expect(executeProgram('go', 'package main;' + body)).toMatchObject({ kind: 'compileError' });
});

test('generic function and method expression values reject expanding instantiation cycles', () => {
  for (const body of [
    'func F[T any](){_=F[[]T]};func main(){}',
    'type A int;func(A)F[T any](){_=A.F[[]T]};func main(){}',
  ]) {
    const result = executeProgram('go', 'package main;' + body);
    expect(result).toMatchObject({ kind: 'compileError' });
    if (result.kind === 'compileError') expect(JSON.stringify(result.diagnostics)).toContain('インスタンス化');
  }
});

test('generic constraints, native values and named pointers preserve compile rejection', () => {
  for (const body of [
    'func f[T any,M ~map[T]int](_ M){};func main(){}',
    'func f[M ~map[[1]T]int,T any](_ M){};func main(){}',
    'func f[M ~map[struct{V T}]int,T any](_ M){};func main(){}',
    'func f[T ~int|~int64](x T){for range x{}};func main(){}',
    'func f[T ~uint|~uint8](x T){for i:=range x{_=i}};func main(){}',
    'import "math/big";func f[T comparable](x T){};func main(){f(big.Int{})}',
    'import "math/big";func main(){_=map[big.Rat]int{}}',
    'import "sync";func f[T comparable](x T){};func main(){f(sync.Map{})}',
    'import "math/big";func main(){a:=big.Int{};_=a==a}',
    'import "math/big";type N big.Int;func main(){_=map[N]int{}}',
    'type A struct{X int `json:"a"`};type B struct{X int `json:"b"`};type P *A;type Q *B;func main(){var p P;_=Q(p)}',
    'type A struct{X int `json:"a"`};type B struct{X int `json:"b"`};type P *A;func main(){var p P;_=(*B)(p)}',
    'func choose[T any](a,b T)T{return a};func main(){var a chan<-int;var b <-chan int;_=choose(a,b)}',
    'func choose[T any](a,b T)T{return a};type C chan int;func main(){var a C;var b chan<-int;_=choose(a,b)}',
  ])
    expect(executeProgram('go', 'package main;' + body)).toMatchObject({ kind: 'compileError' });
});

test('unavailable native methods and dot-import members share diagnostics', () => {
  for (const body of [
    'import . "time";func main(){_,_=LoadLocation("UTC")}',
    'import . "runtime";func main(){_=NumGoroutine()}',
    'import "math/big";func main(){_=big.NewInt(1).Bytes()}',
    'import "math/big";func main(){_=(*big.Int).Bytes}',
    'import "math/big";func main(){big.NewRat(1,2).SetUint64(3)}',
  ]) {
    const result = executeProgram('go', 'package main;' + body);
    expect(result).toMatchObject({
      kind: 'compileError',
      diagnostics: [expect.objectContaining({ message: expect.stringMatching(/は、この採点環境では使えません。$/) })],
    });
  }
});

test('omitted constant diagnostics identify the active spec for 128 << iota', () => {
  expect(executeProgram('go', 'package main\nconst (\n A uint8 = 128 << iota\n B\n)\nfunc main(){}')).toMatchObject({
    kind: 'compileError',
    diagnostics: [expect.objectContaining({ row: 3 })],
  });
});

test('omitted constant diagnostics identify the active spec for 1/(iota-1)', () => {
  expect(executeProgram('go', 'package main\nconst (\n A = 1/(iota-1)\n B\n)\nfunc main(){}')).toMatchObject({
    kind: 'compileError',
    diagnostics: [expect.objectContaining({ row: 3 })],
  });
});
