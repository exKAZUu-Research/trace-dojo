import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test.each(['select {}', '<-make(chan int)'])('an unobserved live ticker does not prevent deadlock with %s', (wait) => {
  expect(
    executeProgram(
      'go',
      `package main
import "time"
func main() { ticker := time.NewTicker(time.Nanosecond); _ = ticker; ${wait} }`
    )
  ).toMatchObject({ kind: 'executed', uncaughtException: 'fatal error: all goroutines are asleep - deadlock!' });
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

test('read lockers share RWMutex state and satisfy Locker', () => {
  const source = `package main
import("fmt";"sync")
func main(){var rw sync.RWMutex;rw.Lock();var reader sync.Locker=rw.RLocker();entered:=make(chan bool);done:=make(chan bool);go func(){entered<-true;reader.Lock();fmt.Println("reader");reader.Unlock();done<-true}();<-entered;fmt.Println("waiting");rw.Unlock();<-done;fmt.Println(rw.TryLock());rw.Unlock();var lock sync.Locker=&sync.Mutex{};lock.Lock();lock.Unlock()}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: 'waiting\nreader\ntrue\n',
    uncaughtException: undefined,
  });
});

test.each(['nil', 'task'])('AfterFunc launches a nil callback fatally: %s', (callback) => {
  const source = `package main
import "time"
func main(){var task func();_=task;time.AfterFunc(1,${callback});time.Sleep(time.Millisecond)}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException: 'fatal error: go of nil func value',
  });
});

test('a stopped nil AfterFunc can be reset without becoming a channel timer', () => {
  const source = `package main
import("fmt";"time")
func main(){t:=time.AfterFunc(time.Hour,nil);fmt.Println(t.C==nil,t.Stop(),t.Reset(time.Hour));time.Sleep(2*time.Hour)}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: 'true true false\n',
    uncaughtException: 'fatal error: go of nil func value',
  });
});

test('virtual nanoseconds and timer order remain exact after long sleeps', () => {
  const source = `package main
import("fmt";"time")
func main(){time.Sleep(105*24*time.Hour);start:=time.Now();time.Sleep(time.Nanosecond);fmt.Println(time.Since(start));later:=time.NewTimer(time.Nanosecond);earlier:=time.NewTimer(0);select{case <-later.C:fmt.Println("later");case <-earlier.C:fmt.Println("earlier")}}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: '1ns\nearlier\n',
    uncaughtException: undefined,
  });
});

test.each([
  ['*Turtle', 'NewTurtle(0,1)'],
  ['[]*Turtle', '[]*Turtle{NewTurtle(0,1)}'],
])('Go frames release cleared launch arguments of type %s', (type, initial) => {
  const source = `package main
import("fmt";"runtime")
var held ${type}
func main(){held=${initial};p:=NewTurtle(0,0);done:=make(chan bool);go func(t ${type}){held=nil;t=nil;fmt.Println(p.CanMoveForward());done<-true}(held);runtime.Gosched();<-done}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: 'true\n',
    uncaughtException: undefined,
  });
});

test('WaitGroup.Go retains queued task captures', () => {
  const source = `package main
import("fmt";"sync")
func launch(w *sync.WaitGroup){t:=NewTurtle(0,1);w.Go(func(){t.Forward()})}
func main(){var w sync.WaitGroup;launch(&w);p:=NewTurtle(0,0);fmt.Println(p.CanMoveForward());w.Wait()}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: 'false\n',
    uncaughtException: undefined,
  });
});

test('sync.Map hashes keys and performs conditional updates atomically', () => {
  const source = `package main
import("fmt";"sync")
func main(){var m sync.Map;for i:=0;i<20000;i++{m.Store(i,i)};fmt.Println(m.Load(19999));fmt.Println(m.CompareAndSwap(1,1,7),m.CompareAndSwap(1,1,8));fmt.Println(m.CompareAndDelete(1,1),m.CompareAndDelete(1,7));fmt.Println(m.Load(1));m.Store("slice",[]int{1});func(){defer func(){fmt.Println(recover()!=nil)}();m.CompareAndSwap("slice",[]int{1},2)}()}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: '19999 true\ntrue false\nfalse true\n<nil> false\ntrue\n',
    uncaughtException: undefined,
  });
});

test('channel range retains received values through indexed destination preparation', () => {
  for (const buffered of [true, false]) {
    const source = `package main
import "fmt"
func idx()int{p:=NewTurtle(0,0);fmt.Println(p.CanMoveForward());return 0}
func main(){c:=make(chan *Turtle,${buffered ? 1 : 0});${buffered ? 'c<-NewTurtle(0,1);close(c)' : 'go func(){c<-NewTurtle(0,1);close(c)}()'};a:=make([]*Turtle,1);for a[idx()]=range c{};a[0].Forward()}`;
    expect(executeProgram('go', source)).toMatchObject({
      kind: 'executed',
      stdout: 'false\n',
      uncaughtException: undefined,
    });
  }
});

test('delivered channel payloads stay live until ordinary or select receivers resume', () => {
  for (const selected of [false, true]) {
    const source = `package main
import "fmt"
func main(){c:=make(chan *Turtle);go func(){c<-NewTurtle(0,1);p:=NewTurtle(0,0);fmt.Println(p.CanMoveForward())}();var t *Turtle;${selected ? 'select{case t=<-c:}' : 't=<-c'};t.Forward()}`;
    expect(executeProgram('go', source)).toMatchObject({
      kind: 'executed',
      stdout: 'false\n',
      uncaughtException: undefined,
    });
  }
});

test('switch tags retain received turtles during case callbacks', () => {
  for (const composite of [false, true]) {
    const type = composite ? 'struct{P *Turtle}' : '*Turtle';
    const returned = composite ? 'struct{P *Turtle}{NewTurtle(2,2)}' : 'NewTurtle(2,2)';
    const tag = composite ? 'struct{P *Turtle}{<-c}' : '<-c';
    const source = `package main
import "fmt"
func other() ${type}{p:=NewTurtle(0,0);fmt.Println(p.CanMoveForward());return ${returned}}
func main(){c:=make(chan *Turtle,1);c<-NewTurtle(0,1);switch ${tag}{case other():fmt.Println("same");default:fmt.Println("different",NewTurtle(0,0).CanMoveForward())}}`;
    expect(executeProgram('go', source)).toMatchObject({
      kind: 'executed',
      stdout: 'false\ndifferent true\n',
      uncaughtException: undefined,
    });
  }
});

test('failed hoist evaluation releases partial argument and condition roots', () => {
  for (const concurrent of [false, true]) {
    for (const condition of [false, true]) {
      const source = `package main
import ("fmt";${concurrent ? '_ "time"' : ''})
func boom()int{panic("oops")}
func use(t *Turtle,i int)bool{return true}
func main(){p:=NewTurtle(0,0);defer func(){recover();fmt.Println(p.CanMoveForward())}();${condition ? 'if use(NewTurtle(0,1),boom()){}' : 'use(NewTurtle(0,1),boom())'}}`;
      expect(executeProgram('go', source)).toMatchObject({
        kind: 'executed',
        stdout: 'true\n',
        uncaughtException: undefined,
      });
    }
  }
});

test('channel close chooses the earliest blocked select case across both directions', () => {
  for (const sendFirst of [false, true]) {
    const sending = 'case c<-1:fmt.Println("sent")';
    const receiving = 'case <-c:fmt.Println("receive")';
    const source = `package main
import "fmt"
func main(){defer func(){if p:=recover();p!=nil{fmt.Println("panic",p)}}();c:=make(chan int);go func(){close(c)}();select{${sendFirst ? sending + ';' + receiving : receiving + ';' + sending}}}`;
    expect(executeProgram('go', source)).toMatchObject({
      kind: 'executed',
      stdout: sendFirst ? 'panic send on closed channel\n' : 'receive\n',
      uncaughtException: undefined,
    });
  }
});

test('final collection drops queued and blocked goroutines while retaining main roots', () => {
  for (const blocked of [false, true]) {
    const source = `package main
import "time"
func main(){keep:=NewTurtle(2,2);go func(t *Turtle){select{}}(NewTurtle(0,0));${blocked ? 'time.Sleep(1)' : '_ = time.Second'};_ = keep}`;
    const result = executeProgram('go', source);
    expect(result).toMatchObject({ kind: 'executed', uncaughtException: undefined });
    if (result.kind === 'executed') expect(result.finalTurtles).toEqual([expect.objectContaining({ x: 2, y: 2 })]);
  }
});

test('terminated workers release suspended native callbacks and accumulators', () => {
  for (const body of [
    'var m sync.Map;m.Store("t",NewTurtle(0,1));m.Range(func(_, _ any)bool{close(ready);<-make(chan int);return true})',
    'slices.Collect(func(yield func(*Turtle)bool){yield(NewTurtle(0,1));close(ready);<-make(chan int)})',
  ]) {
    const source = `package main
import(${body.startsWith('var') ? '"sync"' : '"slices"'})
func main(){ready:=make(chan bool);go func(){${body}}();<-ready}`;
    expect(executeProgram('go', source)).toMatchObject({
      kind: 'executed',
      uncaughtException: undefined,
      finalTurtles: [],
    });
  }
});

test('escaped Pull contexts own suspended native roots independently of their creator', () => {
  for (const retain of [false, true]) {
    const source = `package main
import("fmt";"iter";"slices")
func main(){ready:=make(chan func()(int,bool));go func(){next,_:=iter.Pull(func(yield func(int)bool){out:=slices.Collect(func(inner func(*Turtle)bool){inner(NewTurtle(0,1));yield(1)});_=out});next();ready<-next}();next:=<-ready;${retain ? '' : 'next=nil;'}_ = next;p:=NewTurtle(0,0);fmt.Println(p.CanMoveForward())}`;
    expect(executeProgram('go', source)).toMatchObject({
      kind: 'executed',
      stdout: retain ? 'false\n' : 'true\n',
      uncaughtException: undefined,
    });
  }
});

test('observed ticker loops remain bounded by the execution budget', () => {
  expect(
    executeProgram(
      'go',
      'package main;import "time";func main(){ticker:=time.NewTicker(time.Nanosecond);defer ticker.Stop();for range ticker.C{}}'
    )
  ).toMatchObject({ kind: 'limitExceeded' });
});

test('blocked sends retain their channels and buffered composite payloads', () => {
  for (const composite of [false, true]) {
    for (const selected of [false, true]) {
      const type = composite ? '[]*Turtle' : '*Turtle';
      const initial = composite ? '[]*Turtle{NewTurtle(0,1)}' : 'NewTurtle(0,1)';
      const source = `package main
import "fmt"
func main(){c:=make(chan ${type},1);c<-${initial};go func(){c=nil;p:=NewTurtle(0,0);fmt.Println(p.CanMoveForward())}();${selected ? 'select{case c<-nil:}' : 'c<-nil'}}`;
      expect(executeProgram('go', source)).toMatchObject({
        kind: 'executed',
        stdout: 'false\n',
        uncaughtException: 'fatal error: all goroutines are asleep - deadlock!',
      });
    }
  }
});

test('an unobserved ticker reports deadlock after its last receive', () => {
  const source =
    'package main;import("fmt";"time");func main(){ticker:=time.NewTicker(time.Millisecond);defer ticker.Stop();<-ticker.C;fmt.Println("start");var c chan int;for range c{}}';
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: 'start\n',
    uncaughtException: 'fatal error: all goroutines are asleep - deadlock!',
  });
});

test('SortedFunc comparators suspend throughout Go sorting algorithms', () => {
  expect(
    executeProgram(
      'go',
      'package main\nimport("fmt";"slices")\ntype Item struct{K int; ID int}\nfunc main(){\n c:=make(chan int);go func(){for {c<-1}}()\n for pattern:=0;pattern<5;pattern++{\n  values:=make([]Item,80)\n  for i:=range values{key:=i;switch pattern{case 1:key=80-i;case 2:key=(i*37+11)%23;case 3:key=1;case 4:if i>40{key=80-i}};values[i]=Item{key,i}}\n  calls:=0;hash:=0\n  result:=slices.SortedFunc(slices.Values(values),func(a,b Item)int{<-c;calls++;hash=(hash*31+a.ID*13+b.ID)%1000003;return a.K-b.K})\n  fmt.Println(pattern,result,calls,hash)\n }\n var empty []Item\n fmt.Println(slices.SortedFunc(slices.Values(empty),nil)==nil)\n}'
    )
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '0 [{0 0} {1 1} {2 2} {3 3} {4 4} {5 5} {6 6} {7 7} {8 8} {9 9} {10 10} {11 11} {12 12} {13 13} {14 14} {15 15} {16 16} {17 17} {18 18} {19 19} {20 20} {21 21} {22 22} {23 23} {24 24} {25 25} {26 26} {27 27} {28 28} {29 29} {30 30} {31 31} {32 32} {33 33} {34 34} {35 35} {36 36} {37 37} {38 38} {39 39} {40 40} {41 41} {42 42} {43 43} {44 44} {45 45} {46 46} {47 47} {48 48} {49 49} {50 50} {51 51} {52 52} {53 53} {54 54} {55 55} {56 56} {57 57} {58 58} {59 59} {60 60} {61 61} {62 62} {63 63} {64 64} {65 65} {66 66} {67 67} {68 68} {69 69} {70 70} {71 71} {72 72} {73 73} {74 74} {75 75} {76 76} {77 77} {78 78} {79 79}] 91 23509\n1 [{1 79} {2 78} {3 77} {4 76} {5 75} {6 74} {7 73} {8 72} {9 71} {10 70} {11 69} {12 68} {13 67} {14 66} {15 65} {16 64} {17 63} {18 62} {19 61} {20 60} {21 59} {22 58} {23 57} {24 56} {25 55} {26 54} {27 53} {28 52} {29 51} {30 50} {31 49} {32 48} {33 47} {34 46} {35 45} {36 44} {37 43} {38 42} {39 41} {40 40} {41 39} {42 38} {43 37} {44 36} {45 35} {46 34} {47 33} {48 32} {49 31} {50 30} {51 29} {52 28} {53 27} {54 26} {55 25} {56 24} {57 23} {58 22} {59 21} {60 20} {61 19} {62 18} {63 17} {64 16} {65 15} {66 14} {67 13} {68 12} {69 11} {70 10} {71 9} {72 8} {73 7} {74 6} {75 5} {76 4} {77 3} {78 2} {79 1} {80 0}] 91 875506\n2 [{0 37} {0 14} {0 60} {1 65} {1 42} {1 19} {2 70} {2 47} {2 24} {2 1} {3 75} {3 6} {3 52} {3 29} {4 57} {4 11} {4 34} {5 16} {5 62} {5 39} {6 44} {6 67} {6 21} {7 3} {7 49} {7 26} {7 72} {8 77} {8 31} {8 54} {8 8} {9 59} {9 36} {9 13} {10 41} {10 64} {10 18} {11 69} {11 0} {11 46} {11 23} {12 5} {12 28} {12 74} {12 51} {13 56} {13 33} {13 79} {13 10} {14 61} {14 38} {14 15} {15 20} {15 43} {15 66} {16 71} {16 25} {16 2} {16 48} {17 30} {17 76} {17 53} {17 7} {18 12} {18 35} {18 58} {19 17} {19 40} {19 63} {20 68} {20 45} {20 22} {21 27} {21 73} {21 4} {21 50} {22 9} {22 32} {22 55} {22 78}] 461 248620\n3 [{1 0} {1 1} {1 2} {1 3} {1 4} {1 5} {1 6} {1 7} {1 8} {1 9} {1 10} {1 11} {1 12} {1 13} {1 14} {1 15} {1 16} {1 17} {1 18} {1 19} {1 20} {1 21} {1 22} {1 23} {1 24} {1 25} {1 26} {1 27} {1 28} {1 29} {1 30} {1 31} {1 32} {1 33} {1 34} {1 35} {1 36} {1 37} {1 38} {1 39} {1 40} {1 41} {1 42} {1 43} {1 44} {1 45} {1 46} {1 47} {1 48} {1 49} {1 50} {1 51} {1 52} {1 53} {1 54} {1 55} {1 56} {1 57} {1 58} {1 59} {1 60} {1 61} {1 62} {1 63} {1 64} {1 65} {1 66} {1 67} {1 68} {1 69} {1 70} {1 71} {1 72} {1 73} {1 74} {1 75} {1 76} {1 77} {1 78} {1 79}] 91 23509\n4 [{0 0} {1 79} {1 1} {2 2} {2 78} {3 3} {3 77} {4 4} {4 76} {5 5} {5 75} {6 74} {6 6} {7 73} {7 7} {8 72} {8 8} {9 9} {9 71} {10 10} {10 70} {11 69} {11 11} {12 68} {12 12} {13 67} {13 13} {14 14} {14 66} {15 15} {15 65} {16 16} {16 64} {17 17} {17 63} {18 18} {18 62} {19 19} {19 61} {20 60} {20 20} {21 59} {21 21} {22 58} {22 22} {23 23} {23 57} {24 24} {24 56} {25 25} {25 55} {26 26} {26 54} {27 27} {27 53} {28 52} {28 28} {29 51} {29 29} {30 50} {30 30} {31 49} {31 31} {32 48} {32 32} {33 47} {33 33} {34 46} {34 34} {35 45} {35 35} {36 36} {36 44} {37 37} {37 43} {38 38} {38 42} {39 39} {39 41} {40 40}] 445 383671\ntrue\n',
    uncaughtException: undefined,
  });
});

test('SortedStableFunc comparators suspend throughout Go sorting algorithms', () => {
  expect(
    executeProgram(
      'go',
      'package main\nimport("fmt";"slices")\ntype Item struct{K int; ID int}\nfunc main(){\n c:=make(chan int);go func(){for {c<-1}}()\n for pattern:=0;pattern<5;pattern++{\n  values:=make([]Item,80)\n  for i:=range values{key:=i;switch pattern{case 1:key=80-i;case 2:key=(i*37+11)%23;case 3:key=1;case 4:if i>40{key=80-i}};values[i]=Item{key,i}}\n  calls:=0;hash:=0\n  result:=slices.SortedStableFunc(slices.Values(values),func(a,b Item)int{<-c;calls++;hash=(hash*31+a.ID*13+b.ID)%1000003;return a.K-b.K})\n  fmt.Println(pattern,result,calls,hash)\n }\n var empty []Item\n fmt.Println(slices.SortedStableFunc(slices.Values(empty),nil)==nil)\n}'
    )
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '0 [{0 0} {1 1} {2 2} {3 3} {4 4} {5 5} {6 6} {7 7} {8 8} {9 9} {10 10} {11 11} {12 12} {13 13} {14 14} {15 15} {16 16} {17 17} {18 18} {19 19} {20 20} {21 21} {22 22} {23 23} {24 24} {25 25} {26 26} {27 27} {28 28} {29 29} {30 30} {31 31} {32 32} {33 33} {34 34} {35 35} {36 36} {37 37} {38 38} {39 39} {40 40} {41 41} {42 42} {43 43} {44 44} {45 45} {46 46} {47 47} {48 48} {49 49} {50 50} {51 51} {52 52} {53 53} {54 54} {55 55} {56 56} {57 57} {58 58} {59 59} {60 60} {61 61} {62 62} {63 63} {64 64} {65 65} {66 66} {67 67} {68 68} {69 69} {70 70} {71 71} {72 72} {73 73} {74 74} {75 75} {76 76} {77 77} {78 78} {79 79}] 89 960615\n1 [{1 79} {2 78} {3 77} {4 76} {5 75} {6 74} {7 73} {8 72} {9 71} {10 70} {11 69} {12 68} {13 67} {14 66} {15 65} {16 64} {17 63} {18 62} {19 61} {20 60} {21 59} {22 58} {23 57} {24 56} {25 55} {26 54} {27 53} {28 52} {29 51} {30 50} {31 49} {32 48} {33 47} {34 46} {35 45} {36 44} {37 43} {38 42} {39 41} {40 40} {41 39} {42 38} {43 37} {44 36} {45 35} {46 34} {47 33} {48 32} {49 31} {50 30} {51 29} {52 28} {53 27} {54 26} {55 25} {56 24} {57 23} {58 22} {59 21} {60 20} {61 19} {62 18} {63 17} {64 16} {65 15} {66 14} {67 13} {68 12} {69 11} {70 10} {71 9} {72 8} {73 7} {74 6} {75 5} {76 4} {77 3} {78 2} {79 1} {80 0}] 776 284453\n2 [{0 14} {0 37} {0 60} {1 19} {1 42} {1 65} {2 1} {2 24} {2 47} {2 70} {3 6} {3 29} {3 52} {3 75} {4 11} {4 34} {4 57} {5 16} {5 39} {5 62} {6 21} {6 44} {6 67} {7 3} {7 26} {7 49} {7 72} {8 8} {8 31} {8 54} {8 77} {9 13} {9 36} {9 59} {10 18} {10 41} {10 64} {11 0} {11 23} {11 46} {11 69} {12 5} {12 28} {12 51} {12 74} {13 10} {13 33} {13 56} {13 79} {14 15} {14 38} {14 61} {15 20} {15 43} {15 66} {16 2} {16 25} {16 48} {16 71} {17 7} {17 30} {17 53} {17 76} {18 12} {18 35} {18 58} {19 17} {19 40} {19 63} {20 22} {20 45} {20 68} {21 4} {21 27} {21 50} {21 73} {22 9} {22 32} {22 55} {22 78}] 658 400531\n3 [{1 0} {1 1} {1 2} {1 3} {1 4} {1 5} {1 6} {1 7} {1 8} {1 9} {1 10} {1 11} {1 12} {1 13} {1 14} {1 15} {1 16} {1 17} {1 18} {1 19} {1 20} {1 21} {1 22} {1 23} {1 24} {1 25} {1 26} {1 27} {1 28} {1 29} {1 30} {1 31} {1 32} {1 33} {1 34} {1 35} {1 36} {1 37} {1 38} {1 39} {1 40} {1 41} {1 42} {1 43} {1 44} {1 45} {1 46} {1 47} {1 48} {1 49} {1 50} {1 51} {1 52} {1 53} {1 54} {1 55} {1 56} {1 57} {1 58} {1 59} {1 60} {1 61} {1 62} {1 63} {1 64} {1 65} {1 66} {1 67} {1 68} {1 69} {1 70} {1 71} {1 72} {1 73} {1 74} {1 75} {1 76} {1 77} {1 78} {1 79}] 89 960615\n4 [{0 0} {1 1} {1 79} {2 2} {2 78} {3 3} {3 77} {4 4} {4 76} {5 5} {5 75} {6 6} {6 74} {7 7} {7 73} {8 8} {8 72} {9 9} {9 71} {10 10} {10 70} {11 11} {11 69} {12 12} {12 68} {13 13} {13 67} {14 14} {14 66} {15 15} {15 65} {16 16} {16 64} {17 17} {17 63} {18 18} {18 62} {19 19} {19 61} {20 20} {20 60} {21 21} {21 59} {22 22} {22 58} {23 23} {23 57} {24 24} {24 56} {25 25} {25 55} {26 26} {26 54} {27 27} {27 53} {28 28} {28 52} {29 29} {29 51} {30 30} {30 50} {31 31} {31 49} {32 32} {32 48} {33 33} {33 47} {34 34} {34 46} {35 35} {35 45} {36 36} {36 44} {37 37} {37 43} {38 38} {38 42} {39 39} {39 41} {40 40}] 551 55177\ntrue\n',
    uncaughtException: undefined,
  });
});

test('sorted iterator comparator panics unwind after suspension', () => {
  expect(
    executeProgram(
      'go',
      'package main;import("fmt";"slices");func main(){c:=make(chan int);go func(){for{c<-1}}();for mode:=0;mode<2;mode++{a:=[]int{2,1};func(){defer func(){fmt.Println(recover())}();cmp:=func(a,b int)int{<-c;panic("stop")};if mode==0{_=slices.SortedFunc(slices.Values(a),cmp)}else{_=slices.SortedStableFunc(slices.Values(a),cmp)}}();fmt.Println(a)}}'
    )
  ).toMatchObject({ kind: 'executed', stdout: 'stop\n[2 1]\nstop\n[2 1]\n', uncaughtException: undefined });
});
