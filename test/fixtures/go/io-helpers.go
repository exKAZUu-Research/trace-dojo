package main

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"strings"
)

func main() {
	r := io.MultiReader(strings.NewReader("ab"), strings.NewReader("cd"))
	b, err := io.ReadAll(r)
	fmt.Println(string(b), err)
	var buf1, buf2 bytes.Buffer
	w := io.MultiWriter(&buf1, &buf2)
	fmt.Fprint(w, "hi")
	fmt.Println(buf1.String(), buf2.String())
	var log bytes.Buffer
	tee := io.TeeReader(strings.NewReader("tee"), &log)
	io.ReadAll(tee)
	fmt.Println(log.String())
	n, err := io.CopyN(os.Stdout, strings.NewReader("hello world"), 5)
	fmt.Println()
	fmt.Println(n, err)
	n, err = io.CopyN(io.Discard, strings.NewReader("ab"), 5)
	fmt.Println(n, err)
	p := make([]byte, 3)
	k, err := io.ReadAtLeast(strings.NewReader("abcdef"), p, 2)
	fmt.Println(k, err, string(p[:k]))
	k, err = io.ReadAtLeast(strings.NewReader("a"), p, 5)
	fmt.Println(k, err)
	lr := &io.LimitedReader{R: strings.NewReader("xyz"), N: 2}
	d, _ := io.ReadAll(lr)
	fmt.Println(string(d), lr.N)
	rc := io.NopCloser(strings.NewReader("z"))
	fmt.Println(rc.Close())
	fmt.Printf("%T %T\n", io.LimitReader(nil, 1), rc)
}
