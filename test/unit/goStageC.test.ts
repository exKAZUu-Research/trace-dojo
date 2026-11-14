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
