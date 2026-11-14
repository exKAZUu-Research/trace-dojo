import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test.each(['select {}', '<-make(chan int)'])('an unused live ticker cannot evade execution limits with %s', (wait) => {
  expect(
    executeProgram(
      'go',
      `package main
import "time"
func main() { ticker := time.NewTicker(time.Nanosecond); _ = ticker; ${wait} }`
    )
  ).toMatchObject({ kind: 'limitExceeded' });
});

test('package initializers can send, receive, start goroutines, and await timers before init and main', () => {
  const source = `package main
import ("fmt"; "time")
var buffered = make(chan int, 1)
var first = func() int { buffered <- 42; return <-buffered }()
var second = func() int { ch := make(chan int); go func() { ch <- first + 1 }(); return <-ch }()
var timer = time.NewTimer(time.Second)
var fired = <-timer.C
func init() { fmt.Println(first, second, fired.IsZero()) }
func main() { fmt.Println("main") }`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '42 43 false\nmain\n',
  });
});

test('generic deferred calls capture arguments and their effects before later statements', () => {
  const source = `package main
import "fmt"
var count int
func next() int { count++; return count }
func show[T any](x T) { fmt.Println(x) }
func main() {
  x := 1
  defer show(x)
  defer show[int](next())
  x = 2
  fmt.Println("now", count)
}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: 'now 1\n1\n1\n',
  });
});

test('generic goroutines capture arguments before being scheduled', () => {
  const source = `package main
import "fmt"
func put[T any](ch chan T, value T) { ch <- value }
func main() { ch := make(chan int); x := 1; go put(ch, x); x = 2; fmt.Println(x, <-ch) }`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '2 1\n',
  });
});

test('deferred delete, clear, and copy retain their original arguments and run in reverse order', () => {
  const source = `package main
import "fmt"
func clean(m map[int]int, dst, src []int) {
  key := 1
  defer delete(m, key)
  defer clear(src)
  defer copy(dst, src)
  key = 2
  src = []int{9}
}
func main() {
  m := map[int]int{1: 10, 2: 20}
  dst := []int{0, 0}
  src := []int{3, 4}
  clean(m, dst, src)
  fmt.Println(m, dst, src)
}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: 'map[2:20] [3 4] [0 0]\n',
  });
});

test('deferred sends, waits, sleeps, and panic recovery can suspend and resume', () => {
  const source = `package main
import ("fmt"; "sync"; "time")
func worker(id int, done chan int) {
  defer func() { done <- id }()
  fmt.Println("worker", id)
}
func report[T any](done chan T, value T) { if recover() != nil { done <- value } }
func main() {
  done := make(chan int)
  for i := 1; i <= 3; i++ { go worker(i, done) }
  for i := 0; i < 3; i++ { <-done }
  var wg sync.WaitGroup
  defer wg.Wait()
  wg.Add(1)
  go func() { defer wg.Done(); time.Sleep(time.Millisecond); fmt.Println("finished") }()
  errors := make(chan string)
  go func() { defer report(errors, "recovered"); panic("boom") }()
  fmt.Println(<-errors)
  defer time.Sleep(time.Millisecond)
  fmt.Println("end")
}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: 'worker 1\nworker 2\nworker 3\nrecovered\nend\nfinished\n',
  });
});

test('generic methods capture receivers and arguments for go and defer', () => {
  const source = `package main
import "fmt"
type Box struct{ value int }
func (b Box) Show[T any](x T) { fmt.Println(b.value, x) }
func (b Box) Send[T any](ch chan T, x T) { ch <- x }
func main() {
  b := Box{1}
  defer b.Show(5)
  defer b.Show[string]("s")
  ch := make(chan int)
  go b.Send(ch, 7)
  b.value = 2
  fmt.Println(<-ch)
}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '7\n1 s\n1 5\n',
  });
});

test('select prepares both receive destinations before either store', () => {
  const source = `package main
import "fmt"
func main() {
  i := 0
  flags := []bool{false, false}
  ch := make(chan int, 1)
  ch <- 1
  select { case i, flags[i] = <-ch: }
  fmt.Println(i, flags)
}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '1 [true false]\n',
  });
});

test('channel identity survives interface, array, and struct map keys', () => {
  const source = `package main
import "fmt"
func main() {
  c, d := make(chan int), make(chan int)
  interfaces := map[any]int{c: 1, d: 2}
  arrays := map[[1]chan int]int{{c}: 3, {d}: 4}
  type Key struct { C chan int }
  structs := map[Key]int{{c}: 5, {d}: 6}
  var zero chan int
  interfaces[zero] = 7
  fmt.Println(len(interfaces), interfaces[c], interfaces[d], interfaces[zero], len(arrays), arrays[[1]chan int{c}], arrays[[1]chan int{d}], len(structs), structs[Key{c}], structs[Key{d}])
}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '3 1 2 7 2 3 4 2 5 6\n',
  });
});

test('sync.Map validates unhashable keys on empty maps for reads and writes', () => {
  const source = `package main
import ("fmt"; "sync")
func check(action func(*sync.Map)) {
  defer func() { fmt.Println(recover() != nil) }()
  var m sync.Map
  action(&m)
}
func main() {
  check(func(m *sync.Map) { m.Store([]int{1}, 2) })
  check(func(m *sync.Map) { m.Load([]int{1}) })
  check(func(m *sync.Map) { m.Delete([]int{1}) })
  check(func(m *sync.Map) { m.LoadOrStore([]int{1}, 2) })
}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: 'true\ntrue\ntrue\ntrue\n',
  });
});

test('queued arguments and sync maps retain turtles until their owners release them', () => {
  for (const source of [
    `package main
import("fmt";"runtime")
func main(){go func(t *Turtle){t.Forward()}(NewTurtle(0,1));probe:=NewTurtle(0,0);fmt.Println(probe.CanMoveForward());runtime.Gosched()}`,
    `package main
import("fmt";"sync")
func main(){var m sync.Map;m.Store("t",NewTurtle(0,1));probe:=NewTurtle(0,0);fmt.Println(probe.CanMoveForward());v,_:=m.Load("t");v.(*Turtle).Forward()}`,
  ])
    expect(executeProgram('go', source)).toMatchObject({
      kind: 'executed',
      stdout: 'false\n',
      uncaughtException: undefined,
    });
});

test('a nil goroutine launch is fatal before caller continuation or recovery', () => {
  const source = `package main
import "fmt"
func main(){defer func(){fmt.Println("recovered",recover())}();var f func();go f();fmt.Println("continued")}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException: 'fatal error: go of nil func value',
  });
});

test.each([
  ['func(B)Report(c chan int)', 'go B{}.Report(c)'],
  ['func(B)Report[T ~int](c chan T)', 'go B{}.Report(c)'],
  ['func(B)Report(c chan int)', 'var r interface{Report(chan int)}=B{};go r.Report(c)'],
  ['func(B)Report(c chan int)', 'f:=B{}.Report;go f(c)'],
])('goroutine recovery stays local for %s with %s', (signature, launch) => {
  const source = `package main
import "fmt"
type B struct{}
${signature}{fmt.Println("recover",recover());c<-1}
func crash(c chan int){defer func(){<-c}();${launch};panic("boom")}
func main(){crash(make(chan int));fmt.Println("continued")}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: 'recover <nil>\n',
    uncaughtException: 'panic: boom',
  });
});

test('native goroutine invocations retain receiver roots while callbacks run', () => {
  const source = `package main
import("fmt";"sync";"runtime")
func build()*sync.Map{m:=new(sync.Map);m.Store("first",0);m.Store("t",NewTurtle(0,1));return m}
func main(){p:=NewTurtle(0,0);go build().Range(func(k,v any)bool{if k=="first"{fmt.Println(p.CanMoveForward())};return true});runtime.Gosched()}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: 'false\n',
    uncaughtException: undefined,
  });
});

test.each(['_,t:=range slices.All(source())', 't:=range slices.Values(source())'])(
  'range roots native iterator captures across a blocking body: %s',
  (clause) => {
    const source = `package main
import("fmt";"slices")
func source()[]*Turtle{return []*Turtle{nil,NewTurtle(0,1)}}
func main(){p:=NewTurtle(0,0);gate:=make(chan bool);go func(){gate<-true}();for ${clause}{if t==nil{<-gate;fmt.Println(p.CanMoveForward())}}}`;
    expect(executeProgram('go', source)).toMatchObject({
      kind: 'executed',
      stdout: 'false\n',
      uncaughtException: undefined,
    });
  }
);
