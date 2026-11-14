package main

import (
	"fmt"
	"math"
	"math/cmplx"
)

func main() {
	zs := []complex128{1 + 1i, -1 + 0.5i, 3 - 4i, 0.1 + 0.7i, -2.5 - 0.3i, 2, 1i, -1, complex(math.Inf(1), 0), 0}
	for _, z := range zs {
		r, t := cmplx.Polar(z)
		fmt.Println(cmplx.Exp(z), cmplx.Log(z), cmplx.Log10(z), cmplx.Pow(z, 2.5-0.5i), cmplx.Pow(z, 2), r, t, cmplx.Rect(r, t))
	}
	fmt.Println(cmplx.Pow(0, 0), cmplx.Pow(0, -1), cmplx.Pow(0, 1i), cmplx.IsInf(cmplx.Inf()), cmplx.IsNaN(cmplx.NaN()))
	fmt.Println(cmplx.Exp(1i*math.Pi) + 1)
}
