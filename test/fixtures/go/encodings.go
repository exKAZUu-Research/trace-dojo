package main

import (
	"crypto/md5"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"hash/crc32"
	"strings"
)

func main() {
	long := []byte(strings.Repeat("abcdefghij", 20))
	fmt.Printf("%x\n%x\n%d\n", md5.Sum(long), sha256.Sum256(long), crc32.ChecksumIEEE(long))
	fmt.Printf("%x %x\n", md5.Sum(nil), sha256.Sum256([]byte{}))
	for _, s := range []string{"aGk=", "aGk", "aG=k", "a", "!!!!", "aGVsbG8gd29ybGQ=", "aGVsbG8gd29ybGQ"} {
		d, err := base64.StdEncoding.DecodeString(s)
		fmt.Printf("%q %v\n", d, err)
		d, err = base64.RawStdEncoding.DecodeString(s)
		fmt.Printf("%q %v\n", d, err)
	}
	for _, s := range []string{"4g", "abc", "zz00", "0G"} {
		_, err := hex.DecodeString(s)
		fmt.Println(err)
	}
	fmt.Println(binary.BigEndian, binary.LittleEndian.Uint64([]byte{1, 2, 3, 4, 5, 6, 7, 8}))
	defer func() { fmt.Println(recover()) }()
	binary.BigEndian.Uint32([]byte{1})
}
