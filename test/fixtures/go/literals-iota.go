package main

import "fmt"

type Weekday int

const (
	Sunday Weekday = iota
	Monday
	Tuesday
)

const (
	_  = iota
	KB = 1 << (10 * iota)
	MB
	GB
)

const (
	a, b = iota, iota * 10
	c, d
)

func main() {
	fmt.Println(Sunday, Monday, Tuesday, KB, MB, GB, a, b, c, d)
	fmt.Println(0xFF, 0o17, 017, 0b101, 1_000_000, 0x_1F, 0x1p-2, 1_0.5e1, 0x1.8p1, 012i, 0x10i)
	s := `C:\path\n
second line`
	fmt.Println(s, len(s))
	arr := [...]int{1, 2, 3}
	idx := [...]string{3: "d", 1: "b"}
	fmt.Println(len(arr), arr, len(idx), idx)
	var p [](*int)
	fmt.Println(p == nil)
	const local = iota
	fmt.Println(local)
}
