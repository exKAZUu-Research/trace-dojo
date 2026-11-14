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
