package main

import (
	"fmt"
	"regexp"
)

func main() {
	fmt.Printf("%q\n", regexp.MustCompile(`a*`).FindAllString("baaab", -1))
	fmt.Printf("%q\n", regexp.MustCompile(``).FindAllString("abc", -1))
	fmt.Println(regexp.MustCompile(`x*`).ReplaceAllString("abc", "-"))
	fmt.Printf("%q\n", regexp.MustCompile(`x*`).Split("abc", -1))
	fmt.Printf("%q\n", regexp.MustCompile(`,`).Split("a,b,c", 2))
	fmt.Printf("%q\n", regexp.MustCompile(`a`).Split("banana", -1))
	fmt.Println(regexp.MustCompile(`日本`).FindStringIndex("こんにちは日本語"))
	fmt.Println(regexp.MustCompile(`\p{Han}+`).FindAllString("漢字とかなと漢", -1))
	fmt.Println(regexp.MustCompile(`(?m)^\w+$`).FindAllString("ab\ncd\n", -1))
	fmt.Println(regexp.MustCompile(`(?s)a.b`).MatchString("a\nb"), regexp.MustCompile(`a.b`).MatchString("a\nb"))
	fmt.Println(regexp.MustCompile(`[[:alpha:]]+`).FindString("123abc456"))
	fmt.Println(regexp.MustCompile(`\bgo\b`).FindAllStringIndex("go gopher go", -1))
	fmt.Println(regexp.MustCompile(`(\w+)\s(\w+)`).ReplaceAllString("hello world", "${2}_$1x $$ $3"))
	fmt.Println(regexp.MustCompile(`(?P<first>\w+) (?P<last>\w+)`).ReplaceAllString("John Smith", "$last, $first"))
	for _, p := range []string{`a**`, `*a`, `a{1001}`, `[z-a]`, `(?=x)`, `\1`, `a)`, `[abc`, `\`, `x{2,1}`, `\8`} {
		_, err := regexp.Compile(p)
		fmt.Println(err)
	}
	re := regexp.MustCompile(`(a)(x)?`)
	fmt.Println(re.FindStringSubmatchIndex("a"), len(re.FindStringSubmatch("a")))
	fmt.Println(re.SubexpIndex("none"), regexp.MustCompile(`\d+`).FindAllString("1 22 333", 2))
	fmt.Println(regexp.MustCompile(`\.\-\#`).MatchString(".-#"), regexp.MustCompile(`[\-a]+`).FindString("x-a-"))
	defer func() { fmt.Println(recover()) }()
	regexp.MustCompile(`(`)
}
