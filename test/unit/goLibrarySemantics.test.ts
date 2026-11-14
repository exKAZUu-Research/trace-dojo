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
