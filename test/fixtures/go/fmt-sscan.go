package main

import "fmt"

func main() {
	var name string
	var age int
	var h float64
	n, err := fmt.Sscanf("Alice 30 1.65", "%s %d %f", &name, &age, &h)
	fmt.Println(n, err, name, age, h)
	n, err = fmt.Sscanf("x=10,y=20", "x=%d,y=%d", &age, &n)
	fmt.Println(n, err, age)
	var a, b int
	n, err = fmt.Sscan("7 8", &a, &b)
	fmt.Println(n, err, a, b)
	n, err = fmt.Sscan("7\n8", &a, &b)
	fmt.Println(n, err, a, b)
	n, err = fmt.Sscanln("1 2\n3", &a, &b)
	fmt.Println(n, err, a, b)
	n, err = fmt.Sscanln("1\n2", &a, &b)
	fmt.Println(n, err, a, b)
	n, err = fmt.Sscan("abc", &a)
	fmt.Println(n, err)
	n, err = fmt.Sscan("", &a)
	fmt.Println(n, err)
	var hx int
	fmt.Sscanf("ff", "%x", &hx)
	fmt.Println(hx)
	var bo bool
	var r rune
	n, err = fmt.Sscanf("true Z", "%t %c", &bo, &r)
	fmt.Println(n, err, bo, string(r))
	var s1, s2 string
	fmt.Sscan("  leading   spaces  ", &s1, &s2)
	fmt.Printf("%q %q\n", s1, s2)
	var q string
	fmt.Sscanf(`"quoted str"`, "%q", &q)
	fmt.Println(q)
	var u8 uint8
	n, err = fmt.Sscan("300", &u8)
	fmt.Println(n, err, u8)
}
