package main

import (
	"fmt"
	"math"
	"runtime"
	"strconv"
)

func main() {
	for _, n := range []int{0, 1, 22, 23, 100, 308, 309, -1, -22, -300, -323, -324} {
		fmt.Print(math.Pow10(n), " ")
	}
	fmt.Println()
	for _, x := range []float64{0, 1, 0.3, 1e300, 5e-324, -8, math.Inf(1), math.NaN()} {
		s, c := math.Sincos(x)
		fmt.Println(math.Logb(x), math.Ilogb(x), s, c)
	}
	fmt.Println(strconv.IsPrint('a'), strconv.IsPrint('\t'), strconv.IsGraphic('　'), strconv.CanBackquote("a`b"), strconv.CanBackquote("ok"))
	b := strconv.AppendFloat([]byte("x="), 3.25, 'f', 2, 64)
	b = strconv.AppendQuoteRune(b, '☺')
	b = strconv.AppendUint(b, 255, 16)
	fmt.Println(string(b))
	runtime.Gosched()
}
