package main

import "fmt"

type Celsius float64

func main() {
	var a, b int
	var s string
	var f float64
	var c Celsius
	fmt.Println(fmt.Sscanf("12345", "%3d%2d", &a, &b))
	fmt.Println(a, b)
	fmt.Println(fmt.Sscanf("ab", "%c%c", &a, &b))
	fmt.Println(a, b)
	fmt.Println(fmt.Sscanf("1 2", "%d", &a))
	fmt.Println(fmt.Sscanf("1", "%d %d", &a, &b))
	fmt.Println(fmt.Sscanf("1-2", "%d+%d", &a, &b))
	fmt.Println(fmt.Sscanf("3.5e2 x", "%g %s", &f, &s))
	fmt.Println(f, s)
	fmt.Println(fmt.Sscan("0x1F -0b11 017", &a, &b, &f))
	fmt.Println(a, b, f)
	fmt.Println(fmt.Sscan("36.6", &c))
	fmt.Println(c)
	fmt.Println(fmt.Sscanf("50%", "%d%%", &a))
	fmt.Println(a)
	fmt.Println(fmt.Sscan("1.5", &a))
	fmt.Println(fmt.Sscanln("1 x", &a, &b))
	fmt.Println(fmt.Sscanln("1 2 3", &a, &b))
	fmt.Println(fmt.Sscanf("7\n8", "%d\n%d", &a, &b))
	fmt.Println(a, b)
	fmt.Println(fmt.Sscanf("7 8", "%d\n%d", &a, &b))
	var ok bool
	fmt.Println(fmt.Sscan("trux", &ok))
	fmt.Println(fmt.Sscan("5", a))
}
