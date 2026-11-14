import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test('slice iterators read live elements while retaining their initial lengths', () => {
  const source = `package main
import ("fmt"; "slices")
func main() {
  s := []int{1, 2}
  for v := range slices.Values(s) { fmt.Print(v, " "); s[1] = 9 }
  s = []int{1, 2}
  for i, v := range slices.All(s) { fmt.Print(i, ":", v, " "); s[1] = 8 }
  s = []int{1, 2}
  for i, v := range slices.Backward(s) { fmt.Print(i, ":", v, " "); s[0] = 7 }
  fmt.Println()
}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '1 9 0:1 1:8 1:2 0:7 \n',
  });
});

test('Pull suspends native iterators between live reads and predicate calls', () => {
  const source = `package main
import ("fmt"; "iter"; "slices"; "maps"; "strings")
func main() {
  s := []int{1, 2}
  next, stop := iter.Pull(slices.Values(s))
  defer stop()
  fmt.Println(next())
  s[1] = 9
  fmt.Println(next())
  m := map[int]int{1: 10, 2: 20}
  pair, stopPairs := iter.Pull2(maps.All(m))
  defer stopPairs()
  key, _, ok := pair()
  fmt.Println(ok)
  delete(m, 3-key)
  _, _, ok = pair()
  fmt.Println(ok)
  calls := 0
  words, stopWords := iter.Pull(strings.FieldsFuncSeq("a b c", func(r rune) bool { calls++; return r == ' ' }))
  defer stopWords()
  fmt.Println(calls)
  word, ok := words()
  fmt.Println(word, ok, calls)
  stopWords()
  fmt.Println(calls)
}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '1 true\n9 true\ntrue\nfalse\n0\na true 2\n2\n',
  });
});

test('JSON caches distinguish tags and struct conversions ignore tags recursively', () => {
  const source = `package main
import ("fmt"; "encoding/json")
func main() {
  a, _ := json.Marshal(struct{ X int \`json:"a"\` }{1})
  b, _ := json.Marshal(struct{ X int \`json:"b"\` }{2})
  fmt.Println(string(a), string(b))
  var left struct{ X int \`json:"a"\` }
  var right struct{ X int \`json:"b"\` }
  json.Unmarshal([]byte(\`{"a":3}\`), &left)
  json.Unmarshal([]byte(\`{"b":4}\`), &right)
  fmt.Println(left.X, right.X)
  type A struct{ X struct{ Y int \`a\` } }
  type B struct{ X struct{ Y int \`b\` } }
  var original A
  original.X.Y = 7
  converted := B(original)
  pointer := (*B)(&original)
  pointer.X.Y = 9
  fmt.Println(converted.X.Y, original.X.Y)
}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '{"a":1} {"b":2}\n3 4\n7 9\n',
  });
});

test('big integer square roots use exact arithmetic beyond float64 range', () => {
  const source = `package main
import ("fmt"; "math/big")
func main() {
  for _, exponent := range []int64{60, 600} {
    square := new(big.Int).Exp(big.NewInt(10), big.NewInt(exponent), nil)
    expected := new(big.Int).Exp(big.NewInt(10), big.NewInt(exponent/2), nil)
    exact := new(big.Int).Sqrt(square)
    below := new(big.Int).Sqrt(new(big.Int).Sub(square, big.NewInt(1)))
    above := new(big.Int).Sqrt(new(big.Int).Add(square, big.NewInt(1)))
    fmt.Println(exact.Cmp(expected), below.Add(below, big.NewInt(1)).Cmp(expected), above.Cmp(expected))
  }
}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '0 0 0\n0 0 0\n',
  });
});

test('big integer GCD, modular powers, and prefixed digit separators match signed arithmetic', () => {
  const source = `package main
import ("fmt"; "math/big")
func main() {
  for _, pair := range [][2]int64{{-12, 8}, {12, -8}, {-12, -8}, {0, -8}, {-12, 0}, {0, 0}} {
    x, y := new(big.Int), new(big.Int)
    a, b := big.NewInt(pair[0]), big.NewInt(pair[1])
    g := new(big.Int).GCD(x, y, a, b)
    sum := new(big.Int).Add(new(big.Int).Mul(a, x), new(big.Int).Mul(b, y))
    fmt.Println(g, sum.Cmp(g))
  }
  for _, modulus := range []int64{5, -5, 4} {
    z := big.NewInt(77)
    result := z.Exp(big.NewInt(2), big.NewInt(-1), big.NewInt(modulus))
    fmt.Println(result, z)
  }
  for _, text := range []string{"0x_ff", "0b_101", "0o_77", "0_77", "0x__ff", "_12", "12_"} {
    n, ok := new(big.Int).SetString(text, 0)
    fmt.Println(n, ok)
  }
}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout:
      '4 0\n4 0\n4 0\n8 0\n12 0\n0 0\n3 3\n3 3\n<nil> 77\n255 true\n5 true\n63 true\n63 true\n<nil> false\n<nil> false\n<nil> false\n',
  });
});

test('timer channels discard unreceived firings when stopped or reset', () => {
  const source =
    'package main;import("fmt";"time");func main(){t:=time.NewTimer(time.Second);fmt.Println(len(t.C),cap(t.C));time.Sleep(2*time.Second);fmt.Println(t.Stop());select{case <-t.C:fmt.Println("stale");default:fmt.Println("empty")};fmt.Println(t.Reset(time.Second));time.Sleep(2*time.Second);fmt.Println(t.Reset(time.Second));<-t.C;fmt.Println(t.Stop())}';
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '0 0\ntrue\nempty\nfalse\ntrue\nfalse\n',
  });
});

test('rational components remain aliases across assignments and large ratios round correctly', () => {
  const source =
    'package main;import("fmt";"math/big");func main(){r:=big.NewRat(1,2);n:=r.Num();d:=r.Denom();n.SetInt64(3);fmt.Println(r);r.SetFrac64(5,7);fmt.Println(n,d,n==r.Num());n.SetInt64(8);fmt.Println(r);x:=new(big.Int).Lsh(big.NewInt(1),2000);r.SetFrac(x,new(big.Int).Add(x,big.NewInt(1)));f,exact:=r.Float64();fmt.Println(f,exact);fmt.Println(big.NewInt(-1).Uint64())}';
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '3/2\n5 7 true\n8/7\n1 false\n1\n',
  });
});

test('JSON string tags round trip and omitzero consults zero methods', () => {
  const source =
    'package main;import("fmt";"encoding/json";"time");type Z int;func(z Z)IsZero()bool{return z==42};type S struct{N int `json:"n,string"`; B bool `json:"b,string"`;T string `json:"t,string"`;Z Z `json:"z,omitzero"`;D time.Time `json:"d,omitzero"`};func main(){s:=S{N:12,B:true,T:"x",Z:42};b,e:=json.Marshal(s);fmt.Println(string(b),e);var t S;e=json.Unmarshal(b,&t);fmt.Println(t.N,t.B,t.T,e)}';
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '{"n":"12","b":"true","t":"\\"x\\""} <nil>\n12 true x <nil>\n',
  });
});

test('map insertion runs at each yield and chunk panics with a string', () => {
  const source = String.raw`package main;import("fmt";"maps";"slices");func main(){m:=map[int]int{};maps.Insert(m,func(yield func(int,int)bool){yield(1,2);fmt.Println(m[1]);yield(2,3)});fmt.Println(m[2]);func(){defer func(){fmt.Printf("%T %v\n",recover(),"panic")}();_=slices.Chunk([]int{},0)}()}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '2\n3\nstring panic\n',
  });
});

test('receive and select compile channel factories exactly once', () => {
  const source =
    'package main;import "fmt";func factory()chan int{fmt.Println("made");c:=make(chan int,1);c<-7;return c};func main(){fmt.Println(<-factory());select{case x:=<-factory():fmt.Println(x)}}';
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: 'made\n7\nmade\n7\n',
  });
});

test('select evaluates communication operands in order and suspends destination evaluation', () => {
  const source =
    'package main;import "fmt";func c(n int)chan int{fmt.Print(n);return make(chan int,1)};func v(n int)int{fmt.Print(n);return n};func target(c chan int)int{return <-c};func main(){select{case c(1)<-v(2):case c(3)<-v(4):};fmt.Println();data:=make(chan int,1);data<-8;idx:=make(chan int);go func(){idx<-0}();a:=[]int{0};select{case a[target(idx)]=<-data:};fmt.Println(a);var n uint8;for n=range 3{fmt.Print(n)};fmt.Println()}';
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '1234\n[8]\n012\n',
  });
});

test('large native operations stop at interpreter limits before allocating or traversing', () => {
  for (const source of [
    'package main; import "math/big"; func main(){new(big.Int).Lsh(big.NewInt(1),1000000000000)}',
    'package main; import "math/big"; func main(){new(big.Int).Exp(big.NewInt(2),big.NewInt(1000000000000),nil)}',
    'package main; import "container/ring"; func main(){ring.New(1).Move(1000000000000)}',
  ])
    expect(executeProgram('go', source)).toMatchObject({ kind: 'limitExceeded' });
});

test('extreme hexadecimal float exponents cancel without allocating their magnitude', () => {
  const source = `package main
import "fmt"
const x=0x1p2000000000
const y=0x1p-2000000000
func main(){fmt.Println(x/x,y/y)}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: '1 1\n',
    uncaughtException: undefined,
  });
});

test('composite storage and copied method receivers preserve independent Go values', () => {
  const source = `package main
import("fmt";"sync")
type S struct{N int}
func(s S)Next()int{s.N++;return s.N}
type Box struct{mu sync.Mutex}
func main(){s:=[]S{{1}};p:=(*[1]S)(s);field:=&s[0].N;*p=[1]S{{2}};fmt.Println(*field,s);f:=s[0].Next;fmt.Println(f(),f());var a Box;a.mu.Lock();a.mu.Unlock();b:=a;c:=b;c.mu.Lock();b.mu.Lock();fmt.Println("both locked")}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: '2 [{2}]\n3 3\nboth locked\n',
    uncaughtException: undefined,
  });
});

test('suspendable direct calls retain stack allocation capacity and generic binomial boundaries', () => {
  const source = `package main
import("fmt";"runtime";"math/big")
func grow(s []int)[]int{return append(s,1)}
func main(){s:=[]int{};s=grow(s);fmt.Println(cap(s));runtime.Gosched();fmt.Println(new(big.Int).Binomial(5,-1),new(big.Int).Binomial(5,2))}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: '4\n0 10\n',
    uncaughtException: undefined,
  });
});

test.each([
  [4000, 12_674],
  [5000, 16_326],
  [20_000, 77_338],
])('native arithmetic budgets admit factorial of %i', (n, digits) => {
  const source = `package main
import("fmt";"math/big")
func main(){f:=big.NewInt(1);for i:=int64(2);i<=${n};i++{f.Mul(f,big.NewInt(i))};fmt.Println(len(f.String()))}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: `${digits}\n`,
    uncaughtException: undefined,
  });
});

test('native arithmetic budgets admit additions of large operands', () => {
  const source = `package main
import("fmt";"math/big")
func main(){a:=new(big.Int).Lsh(big.NewInt(1),30000);b:=new(big.Int).Set(a);for i:=0;i<5000;i++{a.Add(a,b);a,b=b,a};fmt.Println(len(a.String()))}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: '10076\n',
    uncaughtException: undefined,
  });
});

test('JSON string tag errors preserve typed field paths and inner parse errors', () => {
  const source =
    'package main\nimport("fmt";"encoding/json")\ntype S struct{I int `json:"i,string"`;S string `json:"s,string"`}\nfunc main(){for _,input:=range []string{`{"i":1}`,`{"i":"x"}`,`{"s":"q"}`,`{"i":"true"}`,`{"i":"9999999999999999999999"}`}{var s S;fmt.Println(json.Unmarshal([]byte(input),&s))}}\n';
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout:
      "json: cannot unmarshal number into Go struct field S.i of type int\njson: cannot unmarshal number x into Go struct field S.i of type int\njson: cannot unmarshal string into Go struct field S.s of type string: invalid character 'q' looking for beginning of object key string\njson: cannot unmarshal number true into Go struct field S.i of type int\njson: cannot unmarshal number 9999999999999999999999 into Go struct field S.i of type int\n",
    uncaughtException: undefined,
  });
});

test('integer ranges distinguish bound defaults from assignment destinations', () => {
  const source = String.raw`package main;import "fmt";func main(){var i any;for i=range 3{fmt.Printf("%T ",i)};fmt.Println();a:=[]any{nil};for a[0]=range 3{fmt.Printf("%T:%v ",a[0],a[0])};fmt.Println();for i:=range 'c'{if i==0{fmt.Printf("%T\n",i)}};var n uint8;for n=range 3{fmt.Print(n)};fmt.Println()}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: 'int int int \nint:0 int:1 int:2 \nint32\n012\n',
    uncaughtException: undefined,
  });
});

test('JSON string tags only dereference one pointer', () => {
  const source =
    'package main;import("fmt";"encoding/json");type P *int;func main(){n:=12;p:=&n;s:=struct{A *int `json:",string"`;B **int `json:",string"`;C P `json:",string"`}{p,&p,p};b,e:=json.Marshal(s);fmt.Println(string(b),e);var t struct{B **int `json:",string"`;C P `json:",string"`};e=json.Unmarshal([]byte(`{"B":12,"C":"13"}`),&t);fmt.Println(**t.B,*t.C,e)}';
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: '{"A":"12","B":12,"C":"12"} <nil>\n12 13 <nil>\n',
    uncaughtException: undefined,
  });
});

test('JSON string tags require the complete quoted scalar', () => {
  const source =
    'package main\nimport("fmt";"encoding/json")\ntype S struct{I int `json:"i,string"`;S string `json:"s,string"`}\nfunc main(){for _,input:=range []string{`{"i":"12x"}`,`{"i":"12 34"}`,`{"s":"\\"x\\" \\"y\\""}`}{var s S;fmt.Println(s,json.Unmarshal([]byte(input),&s),s)}}\n';
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout:
      "{0 } json: cannot unmarshal number 12x into Go struct field S.i of type int {0 }\n{0 } json: cannot unmarshal number 12 34 into Go struct field S.i of type int {0 }\n{0 } json: cannot unmarshal string into Go struct field S.s of type string: invalid character ' ' after string value {0 }\n",
    uncaughtException: undefined,
  });
});

test('quoted null clears tagged scalar pointers using the reference token rules', () => {
  const source =
    'package main\nimport("fmt";"encoding/json")\ntype S struct{I *int `json:"i,string"`; B *bool `json:"b,string"`;F *float64 `json:"f,string"`;T *string `json:"t,string"`}\nfunc main(){i,b,f,t:=1,true,1.5,"x";for _,text:=range []string{`{"i":"null","b":"null","f":"null","t":"null"}`,`{"i":null,"b":null,"f":null,"t":null}`,`{"i":"\\u006eull"}`}{s:=S{&i,&b,&f,&t};err:=json.Unmarshal([]byte(text),&s);fmt.Println(s.I==nil,s.B==nil,s.F==nil,s.T==nil,err)}}\n';
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: 'true true true true <nil>\ntrue true true true <nil>\nfalse false false false <nil>\n',
    uncaughtException: undefined,
  });
});

test('byte order append methods grow and preserve endian order', () => {
  const source =
    'package main\nimport("fmt";"encoding/binary")\nfunc main(){for _,order:=range []binary.AppendByteOrder{binary.BigEndian,binary.LittleEndian}{b:=make([]byte,1,2);b[0]=9;b=order.AppendUint16(b,0x1234);b=order.AppendUint32(b,0x12345678);b=order.AppendUint64(b,0x123456789abcdef0);fmt.Println(b,len(b));var empty []byte;fmt.Println(order.AppendUint16(empty,1))}}\n';
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout:
      '[9 18 52 18 52 86 120 18 52 86 120 154 188 222 240] 15\n[0 1]\n[9 52 18 120 86 52 18 240 222 188 154 120 86 52 18] 15\n[1 0]\n',
    uncaughtException: undefined,
  });
});

test('compact hexadecimal literals respect normalized signed exponent bounds', () => {
  const source =
    'package main\nimport "fmt"\nconst x=0x1p2147483646\nconst y=0x1p-2147483649\nconst z=0x0p2147483648\nfunc main(){fmt.Println(x/x,y/y,z)}\n';
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: '1 1 0\n',
    uncaughtException: undefined,
  });
});

test('nil pull iterators remain lazy until next and can be stopped unused', () => {
  const source = `package main
import("fmt";"iter")
func main(){_,stop:=iter.Pull[int](nil);stop();_,stop2:=iter.Pull2[int,int](nil);stop2();next,end:=iter.Pull[int](nil);defer end();defer func(){fmt.Println("recovered",recover()!=nil)}();fmt.Println("created");next()}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: 'created\nrecovered true\n',
    uncaughtException: undefined,
  });
});

test('range iterators cannot swallow a loop-body panic', () => {
  const source = `package main
import "fmt"
func seq(yield func()bool){defer func(){recover()}();yield()}
func main(){defer func(){fmt.Println("outer",recover())}();for range seq{panic("boom")};fmt.Println("continued")}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: 'outer runtime error: range function recovered a loop body panic and did not resume panicking\n',
    uncaughtException: undefined,
  });
});

test('string sequence prefixes do not materialize their unconsumed tails', () => {
  const source = `package main
import("fmt";"strings")
func main(){s:=strings.Repeat(",",100000);lines:=strings.Repeat("\\n",100000);for range 3000{for range strings.SplitSeq(s,","){break};for range strings.SplitAfterSeq(s,","){break};for range strings.Lines(lines){break}};fmt.Println("ok");for _,input:=range []string{"","a,",",a","a,b"}{fmt.Printf("%q %q\\n",collect(strings.SplitSeq(input,",")),collect(strings.SplitAfterSeq(input,",")))};for part:=range strings.SplitSeq("a日",""){fmt.Printf("%q ",part)};fmt.Println()}
func collect(seq func(func(string)bool))[]string{var out []string;for x:=range seq{out=append(out,x)};return out}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: 'ok\n[""] [""]\n["a" ""] ["a," ""]\n["" "a"] ["," "a"]\n["a" "b"] ["a," "b"]\n"a" "日" \n',
  });
});

test('slice collection retains yielded turtles through callbacks and sorting', () => {
  const source = `package main
import("fmt";"slices")
func seq(yield func(*Turtle)bool){yield(NewTurtle(0,1));p:=NewTurtle(0,0);fmt.Println(p.CanMoveForward());yield(p)}
func main(){a:=slices.Collect(seq);a[0].Forward();fmt.Println(len(a))}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: 'false\n2\n',
    uncaughtException: undefined,
  });
  const sorted = `package main
import("fmt";"slices")
func seq(yield func(*Turtle)bool){yield(NewTurtle(2,2));yield(NewTurtle(3,3));yield(NewTurtle(0,1))}
func main(){a:=slices.SortedFunc(seq,func(a,b *Turtle)int{p:=NewTurtle(0,0);fmt.Println(p.CanMoveForward());return 0});fmt.Println(len(a))}`;
  expect(executeProgram('go', sorted)).toMatchObject({
    kind: 'executed',
    stdout: 'false\nfalse\n3\n',
    uncaughtException: undefined,
  });
});

test('AppendSeq updates the original backing array after each yield', () => {
  const source = `package main
import("fmt";"slices")
func main(){s:=make([]int,1,3);s[0]=9;out:=slices.AppendSeq(s,func(yield func(int)bool){yield(1);fmt.Println(s[:2]);yield(2)});fmt.Println(out,cap(out))}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: '[9 1]\n[9 1 2] 3\n',
    uncaughtException: undefined,
  });
});

test('AsType shares custom and multi-error traversal with As', () => {
  const source = `package main
import("fmt";"errors")
type E struct{N int}
func(e *E)Error()string{return "e"}
type Custom struct{}
func(Custom)Error()string{return "custom"}
func(Custom)As(target any)bool{p,ok:=target.(**E);if ok{*p=&E{7}};return ok}
func main(){for _,err:=range []error{nil,errors.New("x"),errors.Join(errors.New("x"),fmt.Errorf("wrap: %w",&E{3})),Custom{}}{v,ok:=errors.AsType[*E](err);if ok{fmt.Println(v.N)}else{fmt.Println(ok)}}}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: 'false\nfalse\n3\n7\n',
    uncaughtException: undefined,
  });
});

test('modular inverse and bit queries use Go boundary behavior', () => {
  const source = `package main
import("fmt";"math/big")
func main(){for _,g:=range []int64{0,1,3,-1}{func(){defer func(){if p:=recover();p!=nil{fmt.Println(p)}}();fmt.Println(new(big.Int).ModInverse(big.NewInt(g),big.NewInt(0)))}()};func(){defer func(){fmt.Println(recover())}();fmt.Println(big.NewInt(3).Bit(-1))}()}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: '<nil>\n1\n<nil>\ndivision by zero\nnegative bit index\n',
    uncaughtException: undefined,
  });
});

test('method aliases resolve to local defined receiver types', () => {
  const source =
    'package main;import "fmt";type T struct{};type A=T;func(A)M(){fmt.Println("method")};func main(){A{}.M()}';
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: 'method\n',
    uncaughtException: undefined,
  });
});

test('generic len cap indexing and slicing validate each constraint term', () => {
  const source =
    'package main;import "fmt";type Bytes interface{~string|~[]byte};func count[T Bytes](x T,b byte)int{n:=0;for i:=0;i<len(x);i++{if x[i]==b{n++}};fmt.Println(string(x[1:]));return n};func numbers[T ~[]int|~[3]int](x T)int{x[0]++;return cap(x)+len(x)+x[0]};func pointer[T ~*[2]int|~*[3]int](x T)int{return len(x)+x[0]};func main(){fmt.Println(count("banana",\'a\'),count([]byte("ab"),\'b\'));fmt.Println(numbers([]int{2}),numbers([3]int{4}),pointer(&[2]int{7}))}';
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: 'anana\nb\n3 1\n5 11 9\n',
    uncaughtException: undefined,
  });
});

test('already due timer channels are ready before select defaults', () => {
  const source =
    'package main;import("fmt";"time");func main(){for _,d:=range []time.Duration{0,-1}{select{case <-time.After(d):fmt.Println("timer");default:fmt.Println("default")};t:=time.NewTimer(d);fmt.Println(len(t.C),cap(t.C),t.Stop());t.Reset(d);select{case <-t.C:fmt.Println("reset");default:fmt.Println("default")}}}';
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: 'timer\n0 0 true\nreset\ntimer\n0 0 true\nreset\n',
    uncaughtException: undefined,
  });
});

test('JSON tags use Go quoted strings and stop at malformed tag syntax', () => {
  const source =
    'package main;import("fmt";"encoding/json");func main(){s:=struct{A int `json:"\\x41"`;B int `json:"\\102"`;C int `json:"日"`;D int `broken json:"wrong"`;E int `json:"\\q"`;F int `other:"x" json:"Ff"`}{1,2,3,4,5,6};b,e:=json.Marshal(s);fmt.Println(string(b),e);var t struct{A int `json:"\\x41"`;C int `json:"日"`};e=json.Unmarshal(b,&t);fmt.Println(t.A,t.C,e)}';
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: '{"A":1,"B":2,"日":3,"D":4,"E":5,"Ff":6} <nil>\n1 3 <nil>\n',
    uncaughtException: undefined,
  });
});

test('binary integer readers scale with consumed widths', () => {
  const source =
    'package main;import("fmt";"encoding/binary");func main(){data:=make([]byte,80000);var sum uint64;for i:=0;i<len(data);i+=8{sum+=binary.LittleEndian.Uint64(data[i:]);sum+=uint64(binary.BigEndian.Uint32(data[i:]));sum+=uint64(binary.LittleEndian.Uint16(data[i:]))};fmt.Println(sum);func(){defer func(){fmt.Println(recover()!=nil)}();binary.BigEndian.Uint64(data[:7])}()}';
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: '0\ntrue\n',
    uncaughtException: undefined,
  });
});

test('invalid receiver aliases, dot imports, recover calls and iterator signatures produce diagnostics', () => {
  for (const body of [
    'type A=int;func(A)M(){};func main(){}',
    'type A=[]int;func(A)M(){};func main(){}',
    'import "time";type A=time.Duration;func(A)M(){};func main(){}',
    'import(. "fmt";. "log");func main(){Println(1)}',
    'import(. "log";. "fmt");func main(){Println(1)}',
    'func main(){defer recover(1)}',
    'func main(){go recover(1)}',
    'type B bool;func seq(yield func()B){yield()};func main(){for range seq{}}',
    'func f[T ~string|~[]byte](x T)int{return cap(x)};func main(){}',
    'func f[T ~[]int|~[]byte](x T){_=x[0]};func main(){}',
    'func f[T ~[]int|~[3]int](x T){_=x[:]};func main(){}',
    'func f[T ~string|~[]byte](x T){_=x[0:1:1]};func main(){}',
    'func f[T ~string|~[]byte](x T){x[0]=1};func main(){}',
  ])
    expect(executeProgram('go', 'package main;' + body)).toMatchObject({ kind: 'compileError' });
});

test('rational strings support base prefixes, decimal and binary exponents and reject malformed forms', () => {
  expect(
    executeProgram(
      'go',
      'package main;import("fmt";"math/big");func main(){for _,s:=range []string{"0","00","012","0b101","0o17","0x1f","0b1.1","0o1.2","0x1.f","1p3","1.2p3","1e2","0x1p-2","0b1e2","0o7e2","1_2.3_4","0x_1.f","0x.8","1.","+1/02","-01/0x10","1/+2","1/-2","1/0","1/2/3",".","1__2","1._2","1_.2","1e_2","1e2_","0e9223372036854775807","0e9223372036854775808","1e9999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999"}{v,ok:=new(big.Rat).SetString(s);fmt.Println(v,ok)}}'
    )
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '0/1 true\n0/1 true\n12/1 true\n5/1 true\n15/1 true\n31/1 true\n3/2 true\n5/4 true\n31/16 true\n8/1 true\n48/5 true\n100/1 true\n1/4 true\n100/1 true\n700/1 true\n617/50 true\n31/16 true\n1/2 true\n1/1 true\n1/2 true\n-1/16 true\n<nil> false\n<nil> false\n<nil> false\n<nil> false\n<nil> false\n<nil> false\n<nil> false\n<nil> false\n<nil> false\n<nil> false\n0/1 true\n<nil> false\n<nil> false\n',
    uncaughtException: undefined,
  });
});

test('omitzero composites compare structural zeros independently of element methods', () => {
  const source =
    'package main;import("fmt";"encoding/json");type Inner int;func(i Inner)IsZero()bool{return i==42};type Outer struct{N Inner};func main(){for _,n:=range []Inner{0,42}{v:=struct{X Outer `json:",omitzero"`;Y [1]Inner `json:",omitzero"`;Z Inner `json:",omitzero"`}{Outer{n},[1]Inner{n},n};b,e:=json.Marshal(v);fmt.Println(string(b),e)}}';
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: '{"Z":0} <nil>\n{"X":{"N":42},"Y":[42]} <nil>\n',
    uncaughtException: undefined,
  });
});

test('JSON field names use configured escaping', () => {
  const source =
    'package main;import("fmt";"encoding/json";"bytes");func main(){v:=struct{X int `json:"<tag>&"`}{1};b,e:=json.Marshal(v);fmt.Println(string(b),e);var buf bytes.Buffer;enc:=json.NewEncoder(&buf);enc.SetEscapeHTML(false);enc.Encode(v);fmt.Print(buf.String())}';
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: '{"\\u003ctag\\u003e\\u0026":1} <nil>\n{"<tag>&":1}\n',
    uncaughtException: undefined,
  });
});

test('ticker invalid resets preserve old ticks and zero timers use Go panics', () => {
  const source =
    'package main;import("fmt";"time");func check(f func()){defer func(){fmt.Println(recover())}();f()};func main(){for _,d:=range []time.Duration{0,-1}{t:=time.NewTicker(1);check(func(){t.Reset(d)});<-t.C;fmt.Println("tick");t.Stop()};var t time.Timer;check(func(){t.Stop()});check(func(){t.Reset(1)});var k time.Ticker;k.Stop();check(func(){k.Reset(1)});check(func(){k.Reset(0)})}';
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout:
      'non-positive interval for Ticker.Reset\ntick\nnon-positive interval for Ticker.Reset\ntick\ntime: Stop called on uninitialized Timer\ntime: Reset called on uninitialized Timer\ntime: Reset called on uninitialized Ticker\nnon-positive interval for Ticker.Reset\n',
    uncaughtException: undefined,
  });
});

test('big integer bases validate before parsing or formatting', () => {
  const source =
    'package main;import("fmt";"math/big");func check(f func()){defer func(){if p:=recover();p!=nil{fmt.Println(p)}}();f()};func main(){for _,b:=range []int{-1,1,63}{check(func(){v,ok:=new(big.Int).SetString("10",b);fmt.Println(v,ok)})};for _,b:=range []int{-1,0,1,63}{check(func(){fmt.Println(big.NewInt(62).Text(b))})};for _,b:=range []int{0,2,36,62}{x,ok:=new(big.Int).SetString("10",b);fmt.Println(x,ok);if b!=0{fmt.Println(big.NewInt(61).Text(b))}}}';
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout:
      'invalid number base -1\ninvalid number base 1\ninvalid number base 63\ninvalid base\ninvalid base\ninvalid base\ninvalid base\n10 true\n2 true\n111101\n36 true\n1p\n62 true\nZ\n',
    uncaughtException: undefined,
  });
});

test('probable primes use Lucas and requested Miller Rabin rounds', () => {
  const source =
    'package main;import("fmt";"math/big");func main(){for _,s:=range []string{"0","2","61","63","97","1009","1373653","3215031751","3825123056546413051","18446744073709551557","1543267864443420616877677640751301","170141183460469231731687303715884105727"}{x,_:=new(big.Int).SetString(s,10);fmt.Print(s);for _,n:=range []int{0,1,20,50}{fmt.Print(" ",x.ProbablyPrime(n))};fmt.Println()};for _,bits:=range []uint{0,1,200000,999999}{x:=new(big.Int).Lsh(big.NewInt(1),bits);fmt.Println(x.TrailingZeroBits(),new(big.Int).Neg(x).TrailingZeroBits())}}';
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout:
      '0 false false false false\n2 true true true true\n61 true true true true\n63 false false false false\n97 true true true true\n1009 true true true true\n1373653 false false false false\n3215031751 false false false false\n3825123056546413051 false false false false\n18446744073709551557 true true true true\n1543267864443420616877677640751301 false false false false\n170141183460469231731687303715884105727 true true true true\n0 0\n1 1\n200000 200000\n999999 999999\n',
    uncaughtException: undefined,
  });
});

test('binary endian values preserve Go type and format contracts', () => {
  const source = String.raw`package main;import("fmt";"encoding/binary");func main(){for _,v:=range []any{binary.BigEndian,binary.LittleEndian}{fmt.Printf("%T %v %#v\n",v,v,v)}}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: 'binary.bigEndian BigEndian binary.BigEndian\nbinary.littleEndian LittleEndian binary.LittleEndian\n',
    uncaughtException: undefined,
  });
});

test('native iterators copy value arguments while retaining references', () => {
  const source =
    'package main;import("fmt";"slices";"maps");type S struct{N int};func main(){a:=[]S{{1}};slices.Values(a)(func(v S)bool{v.N=9;return true});m:=map[int]S{1:{2}};maps.Values(m)(func(v S)bool{v.N=8;return true});b:=[][1]int{{3}};slices.All(b)(func(i int,v [1]int)bool{v[0]=7;return true});p:=&S{4};slices.Values([]*S{p})(func(v *S)bool{v.N=6;return true});fmt.Println(a[0].N,m[1].N,b[0][0],p.N)}';
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: '1 2 3 6\n',
    uncaughtException: undefined,
  });
});

test('WaitGroup detects reuse before the previous waiter resumes', () => {
  const source =
    'package main;import("fmt";"sync";"time");func main(){var w sync.WaitGroup;w.Add(1);go func(){time.Sleep(time.Millisecond);w.Done();w.Add(1)}();defer func(){fmt.Println(recover())}();w.Wait();fmt.Println("returned")}';
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: 'sync: WaitGroup is reused before previous Wait has returned\n',
    uncaughtException: undefined,
  });
});

test('channel directions bind arrows to the leftmost unparenthesized channel', () => {
  const source = String.raw`package main;import "fmt";func produce(out chan<- chan int){c:=make(chan int,2);c<-7;out<-c};func main(){out:=make(chan chan int,1);produce(out);c:=<-out;c<-1;fmt.Println(<-c,<-c);var a chan<- chan int;var b chan (<-chan int);var d chan<- chan<- int;var e chan<- <-chan int;var f <-chan chan<- int;fmt.Printf("%T %T %T %T %T\n",a,b,d,e,f)}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: '7 1\nchan<- chan int chan (<-chan int) chan<- chan<- int chan<- <-chan int <-chan chan<- int\n',
    uncaughtException: undefined,
  });
});

test('tagged anonymous type names include Go quoted tags', () => {
  const source =
    'package main;import "fmt";func main(){fmt.Printf("%T %T\\n",struct{A int `json:"a"`}{},struct{B string `json:"名前"`}{})}';
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: 'struct { A int "json:\\"a\\"" } struct { B string "json:\\"名前\\"" }\n',
    uncaughtException: undefined,
  });
});

test('generic method caches preserve nested type identities', () => {
  const source =
    'package main;import("fmt";"encoding/json");type R struct{};func(R)show[T any](x T){b,e:=json.Marshal(x);fmt.Println(string(b),e)};func first(){type N int;R{}.show(struct{X N}{1})};func second(){type N string;R{}.show(struct{X N}{"ok"})};func main(){first();second();R{}.show(struct{X int `json:"a"`}{2});R{}.show(struct{X int `json:"b"`}{3})}';
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: '{"X":1} <nil>\n{"X":"ok"} <nil>\n{"a":2} <nil>\n{"b":3} <nil>\n',
    uncaughtException: undefined,
  });
});

test('recursive aliases bind through named shells without losing their types', () => {
  const source =
    'package main;import "fmt";type A=*T;type T struct{next A;v int};type L=[]N;type N struct{children L;n int};type I=interface{J};type J interface{M(int)};type K=map[Key]int;type Key struct{n int};func main(){var t T;t.next=&T{v:3};n:=N{children:[]N{{n:4}}};m:=K{Key{2}:5};fmt.Println(t.next.v,n.children[0].n,m[Key{2}]);var i I;fmt.Println(i==nil)}';
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: '3 4 5\ntrue\n',
    uncaughtException: undefined,
  });
});

test('generic function values infer remaining types from assignment targets', () => {
  const source =
    'package main;import "fmt";func Map[T,U any](xs []T,f func(T)U)[]U{var out []U;for _,x:=range xs{out=append(out,f(x))};return out};func main(){var f func([]int,func(int)string)[]string=Map[int];var g func([]int,func(int)string)[]string=Map;fmt.Println(f([]int{1,2},func(x int)string{return fmt.Sprint(x)}),g([]int{3},func(x int)string{return fmt.Sprint(x)}))}';
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: '[1 2] [3]\n',
    uncaughtException: undefined,
  });
});

test('array conversion pointers share canonical locations and map keys', () => {
  const source =
    'package main;import "fmt";func main(){arr:=[4]int{1,2,3,4};s:=arr[1:];p:=(*[2]int)(s);fmt.Println((*[4]int)(arr[:])==&arr,(*[2]int)(s)==p,&p[0]==&arr[1]);m:=map[*int]int{&p[0]:1,&s[0]:2};fmt.Println(len(m),m[&arr[1]]);q:=(*[1]int)(p[:][1:]);fmt.Println(&q[0]==&arr[2]);*p=[2]int{7,8};fmt.Println(arr)}';
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: 'true true true\n1 2\ntrue\n[1 7 8 4]\n',
    uncaughtException: undefined,
  });
});

test('range destinations can suspend for collections channels and iterator functions', () => {
  const source =
    'package main;import "fmt";func main(){for kind:=range 3{a:=[]int{0};idx:=make(chan int);go func(){idx<-0}();switch kind{case 0:for _,a[<-idx]=range []int{7}{};case 1:c:=make(chan int,1);c<-8;close(c);for a[<-idx]=range c{};case 2:seq:=func(yield func(int)bool){yield(9)};for a[<-idx]=range seq{}};fmt.Println(a)}}';
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: '[7]\n[8]\n[9]\n',
    uncaughtException: undefined,
  });
});

test('select bindings share ordinary comma ok and declaration rules', () => {
  const source = String.raw`package main;import "fmt";type B bool;func main(){ch:=make(chan int,2);ch<-1;ch<-2;var v int;var ok B;select{case v,ok=<-ch:fmt.Println(v,ok)};var a any;select{case v,a=<-ch:fmt.Printf("%d %T %v\n",v,a,a)};close(ch);select{case x,ok:=<-ch:fmt.Println(x,ok)}}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: '1 true\n2 bool true\n0 false\n',
    uncaughtException: undefined,
  });
});

test('constraint unions preserve unrestricted interfaces and exact term inclusion', () => {
  const source =
    'package main;import "fmt";func F[T int|any](x T)T{return x};func exact[T int](x T)T{return x};func G[T int](x T)T{return exact(x)};func main(){fmt.Println(F("s"),F(3),G(2))}';
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: 's 3 2\n',
    uncaughtException: undefined,
  });
});

test('collection consumers suspend channel backed sequences', () => {
  const source =
    'package main;import("fmt";"slices";"maps");func seq()func(func(int)bool){return func(yield func(int)bool){c:=make(chan int);go func(){c<-2;c<-1;close(c)}();for v:=range c{if !yield(v){return}}}};func pairs(yield func(int,int)bool){c:=make(chan int);go func(){c<-3;close(c)}();for v:=range c{yield(v,v+1)}};func main(){fmt.Println(slices.Collect(seq()),slices.Sorted(seq()),slices.SortedFunc(seq(),func(a,b int)int{return a-b}),slices.SortedStableFunc(seq(),func(a,b int)int{return a-b}),slices.AppendSeq([]int{0},seq()));m:=maps.Collect(pairs);maps.Insert(m,pairs);fmt.Println(m[3],len(m))}';
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: '[2 1] [1 2] [1 2] [1 2] [0 2 1]\n4 1\n',
    uncaughtException: undefined,
  });
});

test('Pull rejects recursive next calls with a recoverable Go panic', () => {
  const source =
    'package main;import("fmt";"iter");func main(){var next func()(int,bool);next,stop:=iter.Pull(func(yield func(int)bool){func(){defer func(){fmt.Println(recover())}();next()}();yield(7)});defer stop();fmt.Println(next());var n2 func()(int,int,bool);n2,s2:=iter.Pull2(func(yield func(int,int)bool){func(){defer func(){fmt.Println(recover())}();n2()}();yield(8,9)});defer s2();fmt.Println(n2())}';
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: 'iter.Pull: next called again before yield\n7 true\niter.Pull2: next called again before yield\n8 9 true\n',
    uncaughtException: undefined,
  });
});

test('Pull validates escaped yield calls and completion', () => {
  expect(
    executeProgram(
      'go',
      'package main;import("fmt";"iter");func main(){var saved func(int)bool;next,stop:=iter.Pull(func(yield func(int)bool){saved=yield;yield(1);yield(2)});fmt.Println(next());func(){defer func(){fmt.Println(recover())}();saved(3)}();stop();fmt.Println(saved(4));fmt.Println(next())}'
    )
  ).toMatchObject({
    kind: 'executed',
    stdout: '1 true\niter.Pull: yield called again before next\nfalse\n0 false\n',
    uncaughtException: undefined,
  });
});

test('Pull rejects overlapping next calls while a sequence waits', () => {
  expect(
    executeProgram(
      'go',
      'package main;import("fmt";"iter");func main(){entered:=make(chan int);c:=make(chan int);next,_:=iter.Pull(func(yield func(int)bool){close(entered);yield(<-c)});go func(){next()}();<-entered;defer func(){fmt.Println(recover())}();next()}'
    )
  ).toMatchObject({
    kind: 'executed',
    stdout: 'iter.Pull: next called again before yield\n',
    uncaughtException: undefined,
  });
});

test('omitzero handles structural complex zeros', () => {
  expect(
    executeProgram(
      'go',
      'package main;import("fmt";"encoding/json");func main(){v:=struct{A complex64 `json:",omitzero"`;B [1]complex128 `json:",omitzero"`;C struct{N complex64} `json:",omitzero"` }{};b,e:=json.Marshal(v);fmt.Println(string(b),e)}'
    )
  ).toMatchObject({ kind: 'executed', stdout: '{} <nil>\n', uncaughtException: undefined });
});

test('byte string constraints support append and copy across string and slice sources', () => {
  expect(
    executeProgram(
      'go',
      'package main;import "fmt";type Bytes interface{~string|~[]byte};func app[T Bytes](x T)[]byte{return append([]byte{1},x...)};func cp[T Bytes](x T)[]byte{out:=make([]byte,len(x));copy(out,x);return out};type Named []byte;func main(){fmt.Println(app("ab"),app([]byte("cd")),app(Named("ef")),string(cp("gh")),string(cp([]byte("ij"))))}'
    )
  ).toMatchObject({
    kind: 'executed',
    stdout: '[1 97 98] [1 99 100] [1 101 102] gh ij\n',
    uncaughtException: undefined,
  });
});

test('single use string iterators retain their positions with reference update timing', () => {
  expect(
    executeProgram(
      'go',
      String.raw`package main;import("fmt";"strings";"iter");func first(seq iter.Seq[string]){seq(func(s string)bool{fmt.Printf("first:%q\n",s);return false})};func rest(seq iter.Seq[string]){seq(func(s string)bool{fmt.Printf("rest:%q\n",s);return true})};func main(){for _,seq:=range []iter.Seq[string]{strings.Lines("a\nb\nc\n"),strings.SplitSeq("a,b,c",","),strings.SplitAfterSeq("a,b,c",","),strings.SplitSeq("a日","")}{first(seq);rest(seq);rest(seq)}}`
    )
  ).toMatchObject({
    kind: 'executed',
    stdout:
      'first:"a\\n"\nrest:"b\\n"\nrest:"c\\n"\nfirst:"a"\nrest:"a"\nrest:"b"\nrest:"c"\nrest:"c"\nfirst:"a,"\nrest:"a,"\nrest:"b,"\nrest:"c"\nrest:"c"\nfirst:"a"\nrest:"a"\nrest:"日"\n',
    uncaughtException: undefined,
  });
});

test('switch and select branches merge floating product facts at joins', () => {
  expect(
    executeProgram(
      'go',
      'package main;import "fmt";func a(n int,x,y float64)float64{defer func(){}();p:=0.0;switch n{case 1:p=x*y};return p+1};func b(n any,x,y float64)float64{defer func(){}();p:=0.0;switch n.(type){case string:p=x*y};return p+1};func c(n bool,x,y float64)float64{defer func(){}();p:=0.0;ch:=make(chan int,1);if n{ch<-1};select{case <-ch:p=x*y;default:};return p+1};func d(n int,x,y float64)float64{defer func(){}();p:=0.0;switch n{case 0:p=x*y;fallthrough;case 1:p+=1;case 2:p=5};return p+1};func main(){fmt.Println(a(0,1.1,2.2),a(1,1.1,2.2),b(0,1.1,2.2),b("s",1.1,2.2),c(false,1.1,2.2),c(true,1.1,2.2));fmt.Println(d(0,1.1,2.2),d(1,1.1,2.2),d(2,1.1,2.2),d(3,1.1,2.2))}'
    )
  ).toMatchObject({
    kind: 'executed',
    stdout: '1 3.4200000000000004 1 3.4200000000000004 1 3.4200000000000004\n4.42 2 6 1\n',
    uncaughtException: undefined,
  });
});

test('generic channels preserve compatible directions and element types', () => {
  expect(
    executeProgram(
      'go',
      'package main;import "fmt";func recv[C ~chan int|~<-chan int](c C)int{return <-c};func send[C ~chan int|~chan<- int](c C,n int){c<-n};func finish[C ~chan int|~chan<- int](c C){close(c)};func create[C ~chan int|~<-chan int]()C{return make(C,1)};func main(){c:=make(chan int,2);var out chan<- int=c;send(c,7);send(out,8);var in <-chan int=c;fmt.Println(recv(c),recv(in));finish(out);fmt.Println(len(create[chan int]()),cap(create[<-chan int]()))}'
    )
  ).toMatchObject({ kind: 'executed', stdout: '7 8\n0 1\n', uncaughtException: undefined });
});

test('generic assignments preserve unnamed types and all term nilability', () => {
  expect(
    executeProgram(
      'go',
      'package main;import "fmt";func values[S ~[]E,E any](s S)[]E{return s};func into[S ~[]int](s []int)S{return s};func empty[S ~[]int]()S{return nil};func clearChan[C ~chan int](c C)C{return nil};func mixed[T ~[]int|~map[string]int]()T{return nil};type Named []int;func main(){fmt.Println(values(Named{1,2}),into[Named]([]int{3}),empty[Named]()==nil,clearChan(make(chan int))==nil,mixed[map[string]int]()==nil)}'
    )
  ).toMatchObject({ kind: 'executed', stdout: '[1 2] [3] true true true\n', uncaughtException: undefined });
});

test('big integer division families panic with strings and preserve exact invalid bases', () => {
  expect(
    executeProgram(
      'go',
      String.raw`package main;import("fmt";"math/big");func main(){for _,f:=range []func(*big.Int,*big.Int,*big.Int)*big.Int{(*big.Int).Quo,(*big.Int).Rem,(*big.Int).Div,(*big.Int).Mod}{func(){defer func(){p:=recover();fmt.Printf("%T %v\n",p,p)}();f(new(big.Int),big.NewInt(1),big.NewInt(0))}()};func(){defer func(){fmt.Println(recover())}();new(big.Int).SetString("1",9223372036854775807)}()}`
    )
  ).toMatchObject({
    kind: 'executed',
    stdout:
      'string division by zero\nstring division by zero\nstring division by zero\nstring division by zero\ninvalid number base 9223372036854775807\n',
    uncaughtException: undefined,
  });
});

test('JSON field tag parsing shares name dominance lookup and scalar options', () => {
  expect(
    executeProgram(
      'go',
      'package main;import("fmt";"encoding/json");type S struct{F0 int "json:\\"a\\\\\\"b\\",string";F1 int "json:\\"with\\\\\\\\slash\\",string";F2 int "json:\\"single\'quote\\",string";F3 int "json:\\"tick`name\\",string";F4 int "json:\\"a-b\\\\\\"c\\",string";F5 int "json:\\"9\\\\\\"x\\",string";F6 int "json:\\"#x\\\\\\"q\\",string";F7 int "json:\\"<tag>&\\",string";F8 int "json:\\"日\\\\\\"語\\",string";F9 int "json:\\"δ_12\\\\\\"x\\",string";F10 int "json:\\"hello world\\\\\\"tail\\",string";F11 int "json:\\"emoji😀\\",string";F12 int "json:\\"line\\\\nname\\",string"};func main(){s:=S{1,2,3,4,5,6,7,8,9,10,11,12,13};b,e:=json.Marshal(s);fmt.Println(string(b),e);var v S;e=json.Unmarshal(b,&v);fmt.Println(v,e)}'
    )
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '{"with":2,"single":3,"tick":4,"F5":6,"F6":7,"\\u003ctag\\u003e\\u0026":8,"日":9,"δ_12":10,"hello":11,"emoji😀":12,"line\\nname":13} <nil>\n{0 2 3 4 0 6 7 8 9 10 11 12 13} <nil>\n',
    uncaughtException: undefined,
  });
});

test('promoted interface method expressions share ordinary dynamic dispatch', () => {
  expect(
    executeProgram(
      'go',
      'package main;import "fmt";type I interface{M()int};type A int;func(a A)M()int{return int(a)};type S struct{I};type Outer struct{*S};func main(){s:=S{A(7)};fmt.Println(S.M(s),(*S).M(&s));f:=S.M;fmt.Println(f(s));o:=Outer{&s};fmt.Println(Outer.M(o),(*Outer).M(&o));func(){defer func(){fmt.Println(recover()!=nil)}();S.M(S{})}()}'
    )
  ).toMatchObject({ kind: 'executed', stdout: '7 7\n7\n7 7\ntrue\n', uncaughtException: undefined });
});

test('generic method expressions use function instantiation and inference', () => {
  expect(
    executeProgram(
      'go',
      'package main;import "fmt";type A int;func(a A)M[T any](v T)T{return v};func(a A)Pick[T,U any](x T,y U)U{return y};type S struct{A};type Box[T any]struct{V T};func(b Box[T])Pair[U any](u U)(T,U){return b.V,u};func(A)Send[T any](c chan T,v T){c<-v};func main(){f:=A.M[int];var g func(A,int)int=A.M;fmt.Println(A.M(A(0),1),f(A(0),2),g(A(0),3),A.Pick[int](A(0),4,"x"),S.M[string](S{},"s"));a:=A(0);fmt.Println((*A).M[int](&a,5));fmt.Println(Box[int].Pair[string](Box[int]{7},"b"));fmt.Println(A.M[[]int](A(0),[]int{9}));c:=make(chan int);go A.Send[int](A(0),c,8);fmt.Println(<-c)}'
    )
  ).toMatchObject({ kind: 'executed', stdout: '1 2 3 x s\n5\n7 b\n[9]\n8\n', uncaughtException: undefined });
});

test('goto joins preserve reaching definitions across skipped writes and back edges', () => {
  expect(
    executeProgram(
      'go',
      'package main;import "fmt";func f(skip bool,x,y float64)float64{defer func(){}();p:=0.0;if skip{goto L};p=x*y;L:return p+1};func g(n int,x,y float64)float64{defer func(){}();p:=0.0;L:if n==0{return p+1};p=x*y;n--;goto L};func h(x,y float64)float64{defer func(){}();p:=x*y;goto L;p=0;L:return p+1};func k(x,y float64)float64{defer func(){}();p:=0.0;goto B;A:return p+1;B:p=x*y;goto A};func main(){fmt.Println(f(true,1.1,2.2),f(false,1.1,2.2),g(0,1.1,2.2),g(1,1.1,2.2),h(1.1,2.2),k(1.1,2.2))}'
    )
  ).toMatchObject({
    kind: 'executed',
    stdout: '1 3.4200000000000004 1 3.4200000000000004 3.4200000000000004 3.4200000000000004\n',
    uncaughtException: undefined,
  });
});

test('function and channel ranges join product facts even on zero iterations', () => {
  expect(
    executeProgram(
      'go',
      'package main;import "fmt";func f(n int,x,y float64)float64{defer func(){}();p:=0.0;seq:=func(yield func()bool){for i:=0;i<n;i++{if !yield(){return}}};for range seq{p=x*y};return p+1};func g(n int,x,y float64)float64{defer func(){}();p:=0.0;c:=make(chan int,n);for range n{c<-1};close(c);for range c{p=x*y};return p+1};func main(){fmt.Println(f(0,1.1,2.2),f(1,1.1,2.2),g(0,1.1,2.2),g(1,1.1,2.2))}'
    )
  ).toMatchObject({
    kind: 'executed',
    stdout: '1 3.4200000000000004 1 3.4200000000000004\n',
    uncaughtException: undefined,
  });
});

test('rational component references preserve float exactness and zero denominator initialization', () => {
  expect(
    executeProgram(
      'go',
      'package main;import("fmt";"math/big");func main(){r:=big.NewRat(1,4);r.Num().SetInt64(2);fmt.Println(r.Float64());r.Denom().SetInt64(2);fmt.Println(r.Float64());var z big.Rat;d:=z.Denom();d.SetInt64(7);fmt.Println(d,&z,z.Denom());z.Num().SetInt64(3);z.Denom().SetInt64(8);fmt.Println(&z);z.Set(&z);live:=z.Denom();live.SetInt64(4);fmt.Println(&z,z.FloatString(2));live.SetInt64(0);fmt.Println(live,&z,z.Denom());r.Neg(r);fmt.Println(r.Float64())}'
    )
  ).toMatchObject({
    kind: 'executed',
    stdout: '0.5 true\n1 true\n7 0/1 1\n3/1\n3/4 0.75\n0 3/1 1\n-1 true\n',
    uncaughtException: undefined,
  });
});

test('goto joins retain a unique product discovered after its target was compiled', () => {
  const source = `package main
import "fmt"
func h(x,y,c float64)float64{defer func(){}();p:=x*y;goto L;p=0;L:return p+c}
func k(x,y,c float64)float64{defer func(){}();p:=0.0;goto B;A:return p+c;B:p=x*y;goto A}
func copy(skip bool,x,y float64)float64{defer func(){}();p:=0.0;if skip{goto L};p=x*y;L:q:=p;return q+1}
func main(){fmt.Println(h(1.0000000000000002,1.0000000000000002,-1.0000000000000004),k(1.0000000000000002,1.0000000000000002,-1.0000000000000004));fmt.Println(copy(true,1.1,2.2),copy(false,1.1,2.2))}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: '4.930380657631324e-32 4.930380657631324e-32\n1 3.4200000000000004\n',
    uncaughtException: undefined,
  });
});

test('field sequence predicates suspend through channels and mutexes', () => {
  expect(
    executeProgram(
      'go',
      'package main;import("fmt";"strings";"sync");func main(){c:=make(chan bool);go func(){for range 3{c<-true}}();for s:=range strings.FieldsFuncSeq("a b",func(r rune)bool{<-c;return r==\' \'}){fmt.Println(s)};var m sync.Mutex;m.Lock();go func(){m.Unlock()}();for s:=range strings.FieldsFuncSeq("x",func(r rune)bool{m.Lock();m.Unlock();return false}){fmt.Println(s)}}'
    )
  ).toMatchObject({ kind: 'executed', stdout: 'a\nb\nx\n', uncaughtException: undefined });
});

test('big numbers share text and JSON codec methods', () => {
  expect(
    executeProgram(
      'go',
      String.raw`package main;import("fmt";"math/big";"encoding/json");func main(){i:=big.NewInt(123);r:=big.NewRat(1,2);for _,v:=range []any{i,r,[]*big.Int{i,nil},map[string]*big.Rat{"r":r}}{b,e:=json.Marshal(v);fmt.Println(string(b),e)};fmt.Println(json.Unmarshal([]byte("456"),i),i);fmt.Println(json.Unmarshal([]byte("null"),i),i);fmt.Println(json.Unmarshal([]byte("\"3/4\""),r),r);for _,s:=range []string{"0x10","-42","bad"}{e:=i.UnmarshalText([]byte(s));fmt.Println(e==nil)};b,_:=r.AppendText([]byte("r="));fmt.Println(string(b));var p *big.Int;b,_=p.MarshalJSON();fmt.Println(string(b))}`
    )
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '123 <nil>\n"1/2" <nil>\n[123,null] <nil>\n{"r":"1/2"} <nil>\n<nil> 456\n<nil> 456\n<nil> 3/4\ntrue\ntrue\nfalse\nr=3/4\nnull\n',
    uncaughtException: undefined,
  });
});

test('comparable intersections exclude slices from generic operation sets', () => {
  expect(
    executeProgram(
      'go',
      'package main;import "fmt";func f[T interface{~int|~[]int;comparable}](x T)T{return x+1};func g[T interface{~chan int|~[]int;comparable}](x T){close(x)};func main(){fmt.Println(f(3));c:=make(chan int);g(c);_,ok:=<-c;fmt.Println(ok)}'
    )
  ).toMatchObject({ kind: 'executed', stdout: '4\nfalse\n', uncaughtException: undefined });
});

test('forward comparable constraints admit composite map keys', () => {
  expect(
    executeProgram(
      'go',
      'package main;import "fmt";func f[M ~map[[1]T]int,T comparable](m M)int{return len(m)};func g[M ~map[struct{V T}]int,T comparable](m M)int{return len(m)};func main(){fmt.Println(f(map[[1]int]int{{1}:2}),g(map[struct{V int}]int{{1}:2}))}'
    )
  ).toMatchObject({ kind: 'executed', stdout: '1 1\n', uncaughtException: undefined });
});

test('generic calls infer directional channels and honor written arguments', () => {
  expect(
    executeProgram(
      'go',
      String.raw`package main;import "fmt";func choose[T any](a,b T)T{return a};func show[T,U any](x T,y U){fmt.Printf("%T %v\n",x,y)};type Send chan<-int;func main(){c:=make(chan int);var s chan<-int=c;var r <-chan int=c;fmt.Printf("%T %T %T %T\n",choose(c,s),choose(s,c),choose(c,r),choose(r,c));n:=1;show[any](n,2);show[<-chan int](c,3);var named Send=c;fmt.Printf("%T\n",choose(c,named))}`
    )
  ).toMatchObject({
    kind: 'executed',
    stdout: 'chan<- int chan<- int <-chan int <-chan int\nint 2\n<-chan int 3\nmain.Send\n',
    uncaughtException: undefined,
  });
});

test('JSON zero methods retain addressable field identity', () => {
  expect(
    executeProgram(
      'go',
      'package main;import("fmt";"encoding/json");type N int;func(n *N)IsZero()bool{*n=7;return false};type Text string;func(s *Text)IsZero()bool{*s="normalized";return false};type S struct{N N `json:",omitzero"`;T Text `json:",omitzero"`};func main(){s:=S{1,"raw"};b,e:=json.Marshal(&s);fmt.Println(string(b),e,s.N,s.T);s=S{2,"other"};b,e=json.Marshal(s);fmt.Println(string(b),e,s.N,s.T)}'
    )
  ).toMatchObject({
    kind: 'executed',
    stdout: '{"N":7,"T":"normalized"} <nil> 7 normalized\n{"N":7,"T":"normalized"} <nil> 2 other\n',
    uncaughtException: undefined,
  });
});

test('converted array pointers share formatted canonical locations', () => {
  expect(
    executeProgram(
      'go',
      'package main;import "fmt";func main(){a:=[3]int{1,2,3};p:=(*[3]int)(a[:]);fmt.Println(p==&a,fmt.Sprintf("%p",p)==fmt.Sprintf("%p",&a));q:=(*[2]int)(a[1:]);r:=(*[2]int)(p[1:]);fmt.Println(q==r,fmt.Sprintf("%p",q)==fmt.Sprintf("%p",r),fmt.Sprintf("%p",q)!=fmt.Sprintf("%p",p));fmt.Println(fmt.Sprintf("%p",a[:])==fmt.Sprintf("%p",&a[0]))}'
    )
  ).toMatchObject({ kind: 'executed', stdout: 'true true\ntrue true true\ntrue\n', uncaughtException: undefined });
});

test('generic array ranges evaluate bounds and pointer dereferences', () => {
  expect(
    executeProgram(
      'go',
      'package main;import "fmt";func f[T ~[3]int](a []T){defer func(){fmt.Println(recover()!=nil)}();for range a[99]{fmt.Println("body")}};func g[T ~[3]int](p *T){defer func(){fmt.Println(recover()!=nil)}();for range *p{fmt.Println("body")}};func main(){f([][3]int{{}});g[[3]int](nil)}'
    )
  ).toMatchObject({ kind: 'executed', stdout: 'true\ntrue\n', uncaughtException: undefined });
});

test('package validation panics preserve string dynamic types', () => {
  expect(
    executeProgram(
      'go',
      String.raw`package main;import("fmt";"time";"iter");func check(f func()){defer func(){p:=recover();fmt.Printf("%T %v\n",p,p)}();f()};func main(){check(func(){time.NewTicker(0)});check(func(){var t time.Timer;t.Stop()});check(func(){var t time.Ticker;t.Reset(0)});check(func(){var next func()(int,bool);seq:=func(yield func(int)bool){next()};next,_=iter.Pull(seq);next()});check(func(){var escaped func(int)bool;next,_:=iter.Pull(func(yield func(int)bool){escaped=yield;yield(1);yield(2)});next();escaped(3)})}`
    )
  ).toMatchObject({
    kind: 'executed',
    stdout:
      'string non-positive interval for NewTicker\nstring time: Stop called on uninitialized Timer\nstring non-positive interval for Ticker.Reset\nstring iter.Pull: next called again before yield\nstring iter.Pull: yield called again before next\n',
    uncaughtException: undefined,
  });
});

test('XML tags fail explicitly while unrelated tags preserve XML behavior', () => {
  for (const decode of [false, true]) {
    const source =
      `package main
import "encoding/xml"
type S struct{N string ` +
      '`xml:"name"`' +
      `}
func main(){${decode ? 'var s S;xml.Unmarshal([]byte("<S><name>A</name></S>"),&s)' : 'xml.Marshal(S{"A"})'}}`;
    const result = executeProgram('go', source);
    expect(result).toMatchObject({
      kind: 'executed',
      uncaughtException: expect.stringContaining('は、この採点環境では使えません。'),
    });
  }
  const source =
    'package main;import("fmt";"encoding/xml");type S struct{N string `json:"name"`};func main(){b,e:=xml.Marshal(S{"A"});fmt.Println(string(b),e)}';
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: '<S><N>A</N></S> <nil>\n',
    uncaughtException: undefined,
  });
});

test('RWMutex reader batches run before the next waiting writer', () => {
  const source = `package main
import("fmt";"sync";"time";"slices")
func main(){var m sync.RWMutex;done:=make(chan int,3);m.Lock();for _,n:=range []int{1,2}{go func(n int){time.Sleep(time.Duration(n*2-1)*time.Millisecond);m.RLock();done<-n;m.RUnlock()}(n)};go func(){time.Sleep(2*time.Millisecond);m.Lock();done<-3;m.Unlock()}();time.Sleep(4*time.Millisecond);m.Unlock();first:=[]int{<-done,<-done};slices.Sort(first);fmt.Println(first,<-done)}`;
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: '[1 2] 3\n',
    uncaughtException: undefined,
  });
});

test('comparable intersections use strict comparability without changing interface satisfaction', () => {
  expect(
    executeProgram(
      'go',
      'package main\nimport "fmt"\ntype C interface{~struct{X any}|~int;comparable}\nfunc f[T C](x T)T{return x+1}\nfunc g[T interface{~[2]struct{X any}|~int;comparable}](x T)T{return x*2}\nfunc closeIt[T interface{~chan int|~struct{X any};comparable}](x T){close(x)}\nfunc accept[T comparable](x T){fmt.Println(x==x)}\nfunc main(){fmt.Println(f(3),g(4));c:=make(chan int);closeIt(c);_,ok:=<-c;fmt.Println(ok);accept(struct{X any}{1});m:=map[struct{X any}]int{{1}:2};fmt.Println(m[struct{X any}{1}])}'
    )
  ).toMatchObject({ kind: 'executed', stdout: '4 8\nfalse\ntrue\n2\n', uncaughtException: undefined });
});

test('goto joins ignore dead edges while finding later reachable predecessors', () => {
  expect(
    executeProgram(
      'go',
      'package main;import "fmt";func f(x,y,c float64)float64{defer func(){}();p:=x*y;goto L;p=0;goto L;L:return p+c};func g(x,y,c float64)float64{defer func(){}();p:=x*y;L:return p+c;p=0;goto L};func h(x,y,c float64)float64{defer func(){}();p:=0.0;goto B;A:goto C;C:return p+c;B:p=x*y;goto A};func k(x,y,c float64)float64{defer func(){}();p:=x*y;goto L;{p=0;goto L};L:return p+c};func main(){fmt.Println(f(1.0000000000000002,1.0000000000000002,-1.0000000000000004),g(1.0000000000000002,1.0000000000000002,-1.0000000000000004),h(1.0000000000000002,1.0000000000000002,-1.0000000000000004),k(1.0000000000000002,1.0000000000000002,-1.0000000000000004))}'
    )
  ).toMatchObject({
    kind: 'executed',
    stdout: '4.930380657631324e-32 4.930380657631324e-32 4.930380657631324e-32 4.930380657631324e-32\n',
    uncaughtException: undefined,
  });
});

test('forward named type arguments are checked after complete constraint lists', () => {
  expect(
    executeProgram(
      'go',
      'package main;import "fmt";type Key[T comparable]struct{V T};func f[M ~map[Key[T]]int,T comparable](m M)int{return len(m)};func g[S ~[]Key[T],T comparable](s S)int{return len(s)};func main(){fmt.Println(f(map[Key[int]]int{{1}:2}),g([]Key[string]{{"x"}}))}'
    )
  ).toMatchObject({ kind: 'executed', stdout: '1 1\n', uncaughtException: undefined });
});

test('channel conversion calls preserve leading receive operators and parentheses', () => {
  expect(
    executeProgram(
      'go',
      'package main;import "fmt";func main(){c:=make(chan int,3);c<-7;c<-8;c<-9;fmt.Println(<-chan int(c),1+<-chan int(c));r:=(<-chan int)(c);fmt.Println(<-r);inner:=make(chan int,1);inner<-10;outer:=make(chan chan int,1);outer<-inner;fmt.Println(<-(<-chan chan int(outer)));comments:=make(chan int,1);comments<-11;fmt.Println(<- /* r */ chan int(comments))}'
    )
  ).toMatchObject({ kind: 'executed', stdout: '7 9\n9\n10\n11\n', uncaughtException: undefined });
});

test('generic channel inference preserves checked argument provenance in concrete instances', () => {
  expect(
    executeProgram(
      'go',
      String.raw`package main;import "fmt";func pair[T any](a,b T)T{return a};func F[C ~chan int](c C){d:=make(chan int);fmt.Printf("%T %T\n",pair(c,d),pair(d,c));type Local struct{C C};a:=Local{c};fmt.Println(any(pair(a,a)).(Local).C==c)};type B chan int;func main(){F(make(chan int));F(make(B))}`
    )
  ).toMatchObject({
    kind: 'executed',
    stdout: 'chan int chan int\ntrue\nmain.B chan int\ntrue\n',
    uncaughtException: undefined,
  });
});

test('lazy timer reads retain expired timestamps and ticker phase', () => {
  expect(
    executeProgram(
      'go',
      'package main;import("fmt";"time");func main(){start:=time.Now();timer:=time.NewTimer(time.Millisecond);ticker:=time.NewTicker(time.Millisecond);defer ticker.Stop();time.Sleep(10*time.Millisecond);after:=time.Now();a:=<-timer.C;b:=<-ticker.C;c:=<-ticker.C;fmt.Println(a.Before(after),b.Before(after),c.After(after),c.Sub(b)>=time.Millisecond,start.Before(a));done:=make(chan int);time.AfterFunc(time.Millisecond,func(){done<-7});fmt.Println(<-done)}'
    )
  ).toMatchObject({ kind: 'executed', stdout: 'true true true true true\n7\n', uncaughtException: undefined });
});

test('generic channel inference preserves choices across receiver and method parameters', () => {
  expect(
    executeProgram(
      'go',
      'package main\nimport "fmt"\nfunc pair[T any](a,b T)T{return a}\ntype W[C ~chan int] struct{C C}\nfunc(w W[X])Run(){d:=make(chan int);fmt.Printf("%T %T\\n",pair(w.C,d),pair(d,w.C))}\ntype A int\nfunc(A)Run[C ~chan int](c C){d:=make(chan int);fmt.Printf("%T %T\\n",pair(c,d),pair(d,c))}\ntype B chan int\nfunc main(){W[B]{make(B)}.Run();A(0).Run(make(B))}\n'
    )
  ).toMatchObject({ kind: 'executed', stdout: 'main.B chan int\nmain.B chan int\n', uncaughtException: undefined });
});

test('opaque native structural zero checks fail explicitly for every arithmetic result', () => {
  for (const operation of [
    '_=s',
    's.I.Add(big.NewInt(1),big.NewInt(-1))',
    's.I.Sub(big.NewInt(1),big.NewInt(1))',
    's.I.Mul(big.NewInt(1),big.NewInt(0))',
    's.I.SetInt64(0)',
    's.I.SetInt64(123)',
  ]) {
    const source =
      'package main;import("math/big";"encoding/json");type S struct{I big.Int `json:",omitzero"`};func main(){s:=S{};' +
      operation +
      ';json.Marshal(&s)}';
    expect(executeProgram('go', source)).toMatchObject({
      kind: 'executed',
      uncaughtException: expect.stringContaining('は、この採点環境では使えません。'),
    });
  }
  for (const field of ['big.Rat', '[1]big.Int', 'struct{N int;I big.Int}']) {
    const source =
      'package main;import("math/big";"encoding/json");type S struct{V ' +
      field +
      ' `json:",omitzero"`};func main(){json.Marshal(S{})}';
    expect(executeProgram('go', source)).toMatchObject({
      kind: 'executed',
      uncaughtException: expect.stringContaining('は、この採点環境では使えません。'),
    });
  }
});

test('custom zero methods and pointer fields avoid opaque structural inspection', () => {
  expect(
    executeProgram(
      'go',
      'package main\nimport("fmt";"math/big";"encoding/json")\ntype N struct{I big.Int}\nfunc(n N)IsZero()bool{return n.I.Sign()==0}\ntype S struct{N N `json:",omitzero"`;P *big.Int `json:",omitzero"`;A [0]big.Int `json:",omitzero"`}\nfunc main(){s:=S{P:big.NewInt(0)};s.N.I.SetInt64(123);b,e:=json.Marshal(&s);fmt.Println(string(b),e);b,e=json.Marshal(s);fmt.Println(string(b),e);s.N.I.SetInt64(0);b,e=json.Marshal(&s);fmt.Println(string(b),e)}\n'
    )
  ).toMatchObject({
    kind: 'executed',
    stdout: '{"N":{"I":123},"P":0} <nil>\n{"N":{"I":{}},"P":0} <nil>\n{"P":0} <nil>\n',
    uncaughtException: undefined,
  });
});
