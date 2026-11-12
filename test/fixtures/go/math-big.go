package main

import (
	"fmt"
	"math/big"
)

func main() {
	f := new(big.Int)
	f.MulRange(1, 30)
	fmt.Println(f)
	a, ok := new(big.Int).SetString("123456789012345678901234567890", 10)
	b := big.NewInt(987654321)
	fmt.Println(ok, new(big.Int).Add(a, b), new(big.Int).Mul(a, b))
	q, r := new(big.Int).QuoRem(a, b, new(big.Int))
	fmt.Println(q, r)
	fmt.Println(new(big.Int).Exp(big.NewInt(2), big.NewInt(100), nil), new(big.Int).Exp(big.NewInt(3), big.NewInt(200), big.NewInt(1000007)))
	fmt.Println(a.Cmp(b), b.Cmp(a), a.Sign(), new(big.Int).Neg(b), a.BitLen())
	fmt.Printf("%x %X %#x %b %o %O %s %v %d %+d %08d %-6d| %.5d %q\n", b, b, b, big.NewInt(5), big.NewInt(8), big.NewInt(8), b.Text(36), big.NewInt(-5), b, b, big.NewInt(42), big.NewInt(7), big.NewInt(3), b)
	x := big.NewRat(1, 3)
	y := big.NewRat(1, 6)
	fmt.Println(new(big.Rat).Add(x, y), x.FloatString(5), big.NewRat(-2, 3).FloatString(2), big.NewRat(6, 4).RatString())
	fmt.Println(big.NewInt(97).ProbablyPrime(10), new(big.Int).GCD(nil, nil, big.NewInt(48), big.NewInt(18)))
	fmt.Println(new(big.Int).Div(big.NewInt(-7), big.NewInt(2)), new(big.Int).Mod(big.NewInt(-7), big.NewInt(2)), new(big.Int).Quo(big.NewInt(-7), big.NewInt(2)), new(big.Int).Rem(big.NewInt(-7), big.NewInt(2)))
	fmt.Println(new(big.Int).Sqrt(big.NewInt(1000000)), new(big.Int).Binomial(50, 25), new(big.Int).ModInverse(big.NewInt(3), big.NewInt(11)))
	var z big.Int
	fmt.Println(&z, z.String(), z.Int64(), big.NewInt(1).Lsh(big.NewInt(1), 70))
	r2, _ := new(big.Rat).SetString("3.25")
	fl, exact := r2.Float64()
	fmt.Println(r2, fl, exact, r2.Num(), r2.Denom())
	_, ok = new(big.Int).SetString("0x1F", 0)
	fmt.Println(ok)
	var nilInt *big.Int
	fmt.Println(nilInt)
}
