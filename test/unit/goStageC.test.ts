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
