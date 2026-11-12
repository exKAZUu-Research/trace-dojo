package main

import (
	"bufio"
	"fmt"
	"strings"
)

func main() {
	r := bufio.NewReader(strings.NewReader("héllo\nworld\r\nlast"))
	c, size, err := r.ReadRune()
	fmt.Println(string(c), size, err)
	fmt.Println(r.UnreadRune())
	b, _ := r.Peek(3)
	fmt.Printf("%q\n", b)
	line, prefix, err := r.ReadLine()
	fmt.Printf("%q %v %v\n", line, prefix, err)
	line, prefix, err = r.ReadLine()
	fmt.Printf("%q %v %v\n", line, prefix, err)
	by, err := r.ReadByte()
	fmt.Println(by, err, r.UnreadByte(), r.Buffered())
	s, err := r.ReadString('x')
	fmt.Printf("%q %v\n", s, err)
	s, err = r.ReadString('x')
	fmt.Printf("%q %v\n", s, err)
	fmt.Println(r.UnreadByte())
	_, _, err = r.ReadLine()
	fmt.Println(err)
}
