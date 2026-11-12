package main

import (
	"fmt"
	"regexp"
)

func main() {
	re := regexp.MustCompile(`(\w+)@(\w+)\.com`)
	s := "alice@example.com, bob@test.com; nobody@nowhere.org"
	fmt.Println(re.MatchString(s))
	fmt.Println(re.FindString(s))
	fmt.Println(re.FindAllString(s, -1))
	fmt.Println(re.FindStringSubmatch(s))
	fmt.Println(re.FindAllStringSubmatchIndex(s, -1))
	fmt.Println(re.ReplaceAllString(s, "$2:$1"))
	fmt.Println(re.ReplaceAllStringFunc(s, func(m string) string { return "<" + m + ">" }))
	fmt.Println(re.NumSubexp(), re.String())
	named := regexp.MustCompile(`(?P<year>\d{4})-(?P<month>\d{2})`)
	m := named.FindStringSubmatch("date: 2024-05")
	for i, n := range named.SubexpNames() {
		fmt.Printf("%d %q %q\n", i, n, m[i])
	}
	fmt.Println(regexp.MustCompile(`a+b*`).FindAllString("aaabbb ab a b", 2))
	fmt.Printf("%q\n", regexp.MustCompile(`\s*,\s*`).Split("a , b,c ,  d", -1))
	_, err := regexp.Compile(`(unclosed`)
	fmt.Println(err)
	ok, err := regexp.MatchString(`^[ぁ-ん]+$`, "ひらがな")
	fmt.Println(ok, err)
	fmt.Println(regexp.QuoteMeta("1+1=2?"))
	fmt.Println(regexp.MustCompile(`(?i)go`).ReplaceAllLiteralString("Go GO go", "$1"))
}
