import type { ProgrammingLanguage } from '../../src/interpreter/program';

/**
 * A program for each language that prints `42` and a newline. Where the interpreter has regular expressions, the program
 * takes the 6 from a capture group and prints through a replacement.
 */
export const SAMPLE_PROGRAMS: Record<ProgrammingLanguage, string> = {
  c: `#include <stdio.h>
int main(void) {
  int x = 6;
  x = x * 7;
  printf("%d\\n", x);
  return 0;
}`,
  cpp: `#include <iostream>
int main() {
  int x = 6;
  x = x * 7;
  std::cout << x << std::endl;
  return 0;
}`,
  csharp: `using System;
using System.Text.RegularExpressions;

class Program
{
    static void Main()
    {
        int x = int.Parse(Regex.Match("x=6", @"x=(\\d+)").Groups[1].Value);
        x = x * 7;
        Console.WriteLine(Regex.Replace("<" + x + ">", "[<>]", ""));
    }
}`,
  dart: `void main() {
  var x = int.parse(RegExp(r'x=(\\d+)').firstMatch('x=6')!.group(1)!);
  x = x * 7;
  print('<$x>'.replaceAll(RegExp(r'[<>]'), ''));
}`,
  go: `package main

import (
	"fmt"
	"regexp"
	"strconv"
)

func main() {
	x, _ := strconv.Atoi(regexp.MustCompile("x=(\\\\d+)").FindStringSubmatch("x=6")[1])
	x = x * 7
	fmt.Println(regexp.MustCompile("[<>]").ReplaceAllString(fmt.Sprintf("<%d>", x), ""))
}`,
  haskell: `main :: IO ()
main = do
  let x = 6 * 7 :: Int
  print x`,
  java: `public class Main {
  public static void main(String[] args) {
    int x = Integer.parseInt("x=6".replaceAll("x=(\\\\d+)", "$1"));
    x = x * 7;
    System.out.println(("<" + x + ">").replaceAll("[<>]", ""));
  }
}`,
  javascript: `let x = Number(/x=(\\d+)/.exec('x=6')[1]);
x = x * 7;
console.log(('<' + x + '>').replace(/[<>]/g, ''));`,
  kotlin: `fun main() {
    var x = "x=6".substringAfter('=').toInt()
    x = x * 7
    println(x)
}`,
  php: `<?php
preg_match('/x=(\\d+)/', 'x=6', $matches);
$x = (int) $matches[1];
$x = $x * 7;
echo preg_replace('/[<>]/', '', "<$x>"), "\\n";`,
  python: `import re

x = int(re.search(r"x=(\\d+)", "x=6").group(1))
x = x * 7
print(re.sub(r"[<>]", "", f"<{x}>"))`,
  ruby: `x = "x=6"[/x=(\\d+)/, 1].to_i
x = x * 7
puts "<#{x}>".gsub(/[<>]/, "")`,
  rust: `fn main() {
    let mut x = 6;
    x = x * 7;
    println!("{}", x);
}`,
  typescript: `let x: number = Number(/x=(\\d+)/.exec('x=6')?.[1]);
x = x * 7;
console.log(('<' + x + '>').replace(/[<>]/g, ''));`,
  zig: `const std = @import("std");

pub fn main() void {
    var x: i32 = 6;
    x = x * 7;
    std.debug.print("{d}\\n", .{x});
}`,
};
