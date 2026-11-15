package main

import (
	. "fmt"
	"strings"
)

type Reader interface{ Read() string }
type Writer interface{ Write(s string) }
type RW interface {
	Reader
	Writer
}

type buf struct{ data []string }

func (b *buf) Read() string    { return strings.Join(b.data, ",") }
func (b *buf) Write(s string) { b.data = append(b.data, s) }

type Ordered interface {
	~int | ~int64 | ~float64 | ~string
}

func Max[T Ordered](a, b T) T {
	if a > b {
		return a
	}
	return b
}

type Small interface{ int8 | int16 }

func Double[T Small](x T) T { return x * 2 }

func main() {
	var rw RW = &buf{}
	rw.Write("a")
	rw.Write("b")
	Println(rw.Read(), Max(3, 7), Max("x", "a"), Double[int8](60))
	var r Reader = rw
	Printf("%T\n", r)
}
