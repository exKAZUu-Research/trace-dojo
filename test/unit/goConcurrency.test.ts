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
