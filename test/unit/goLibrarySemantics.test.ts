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

test('native arithmetic budgets admit factorial and Fibonacci exercises', () => {
  const source =
    'package main\nimport("fmt";"math/big")\nfunc main(){for _,n:=range []int64{4000,5000,20000}{f:=big.NewInt(1);for i:=int64(2);i<=n;i++{f.Mul(f,big.NewInt(i))};fmt.Println(len(f.String()))};a,b:=big.NewInt(0),big.NewInt(1);for i:=0;i<50000;i++{a.Add(a,b);a,b=b,a};fmt.Println(len(a.String()))}\n';
  expect(executeProgram('go', source)).toMatchObject({
    kind: 'executed',
    stdout: '12674\n16326\n77338\n10450\n',
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
