package main

import (
	"bytes"
	"fmt"
)

func main() {
	var buf bytes.Buffer
	buf.WriteString("hello ")
	buf.Write([]byte("world"))
	buf.WriteByte('!')
	fmt.Fprintf(&buf, " %d", 42)
	fmt.Println(buf.String(), buf.Len())
	p := make([]byte, 5)
	n, _ := buf.Read(p)
	fmt.Println(n, string(p), buf.String())
	line, err := bytes.NewBufferString("a\nb").ReadString('\n')
	fmt.Printf("%q %v\n", line, err)
	b := []byte("Go is fun, Go is fast")
	fmt.Println(bytes.Contains(b, []byte("fun")), bytes.Count(b, []byte("Go")), bytes.Index(b, []byte("is")))
	fmt.Printf("%s\n", bytes.ToUpper(b))
	fmt.Printf("%q\n", bytes.Split([]byte("a,b,c"), []byte(",")))
	fmt.Printf("%q\n", bytes.Fields([]byte(" x  y ")))
	fmt.Printf("%s\n", bytes.ReplaceAll(b, []byte("Go"), []byte("Rust")))
	fmt.Printf("%s|\n", bytes.TrimSpace([]byte("  pad  ")))
	fmt.Println(bytes.Equal([]byte("a"), []byte("a")), bytes.Equal(nil, []byte{}), bytes.Compare([]byte("a"), []byte("b")))
	fmt.Printf("%s\n", bytes.Join([][]byte{[]byte("1"), []byte("2")}, []byte("+")))
	fmt.Println(bytes.HasPrefix(b, []byte("Go")), bytes.EqualFold([]byte("GO"), []byte("go")))
	fmt.Printf("%s\n", bytes.Repeat([]byte("ab"), 3))
	fmt.Printf("%s\n", bytes.Title([]byte("x")))
	var zero bytes.Buffer
	fmt.Printf("%q %d\n", zero.String(), zero.Len())
	buf.Reset()
	buf.WriteRune('日')
	fmt.Println(buf.Bytes(), buf.String())
	before, after, found := bytes.Cut([]byte("k:v"), []byte(":"))
	fmt.Printf("%s %s %v\n", before, after, found)
	r := bytes.NewReader([]byte("reader"))
	fmt.Println(r.Len(), r.Size())
}
