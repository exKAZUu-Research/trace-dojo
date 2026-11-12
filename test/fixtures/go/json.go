package main

import (
	"encoding/json"
	"fmt"
)

type Address struct {
	City string `json:"city"`
	Zip  string `json:"zip,omitempty"`
}

type User struct {
	Name    string            `json:"name"`
	Age     int               `json:"age"`
	Email   string            `json:"-"`
	Tags    []string          `json:"tags"`
	Addr    *Address          `json:"addr,omitempty"`
	Meta    map[string]int    `json:"meta,omitempty"`
	private int
	Score   float64
}

func main() {
	u := User{Name: "太郎", Age: 20, Email: "x", Tags: []string{"a", "<b>"}, Addr: &Address{City: "Tokyo"}, Meta: map[string]int{"z": 1, "a": 2}, Score: 1e21}
	b, err := json.Marshal(u)
	fmt.Println(string(b), err)
	b, _ = json.MarshalIndent(map[string]any{"b": []int{1, 2}, "a": nil, "c": 1.5}, "", "  ")
	fmt.Println(string(b))
	var u2 User
	err = json.Unmarshal([]byte(`{"name":"Bob","age":"x"}`), &u2)
	fmt.Println(err)
	err = json.Unmarshal([]byte(`{"name":"Bob","age":31,"tags":null,"extra":true}`), &u2)
	fmt.Printf("%+v %v\n", u2, err)
	var anyv any
	json.Unmarshal([]byte(`{"n":1,"f":2.5,"s":"str","l":[true,null],"o":{"k":"v"}}`), &anyv)
	fmt.Printf("%v\n", anyv)
	m := anyv.(map[string]any)
	fmt.Printf("%T %T %T %T\n", m["n"], m["s"], m["l"], m["o"])
	err = json.Unmarshal([]byte(`{bad json}`), &anyv)
	fmt.Println(err)
	b, _ = json.Marshal([]any{1, "two", 3.0, nil, true, 1e-7, []byte("hi")})
	fmt.Println(string(b))
	var nums []int
	fmt.Println(json.Unmarshal([]byte("[1,2,3]"), &nums), nums)
	b, _ = json.Marshal(struct{ X, Y int }{1, 2})
	fmt.Println(string(b))
	var nilSlice []string
	b, _ = json.Marshal(struct{ S []string }{nilSlice})
	fmt.Println(string(b))
}
