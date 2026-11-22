import type { ProgrammingLanguage } from '../../src/interpreter/program';

/** A program for each language that prints `42` and a newline. */
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
  dart: `void main() {
  var x = 6;
  x = x * 7;
  print(x);
}`,
  go: `package main

import "fmt"

func main() {
	x := 6
	x = x * 7
	fmt.Println(x)
}`,
  haskell: `main :: IO ()
main = do
  let x = 6 * 7 :: Int
  print x`,
  java: `public class Main {
  public static void main(String[] args) {
    int x = 6;
    x = x * 7;
    System.out.println(x);
  }
}`,
  javascript: `let x = 6;
x = x * 7;
console.log(x);`,
  php: `<?php
$x = 6;
$x = $x * 7;
echo $x, "\\n";`,
  python: `x = 6
x = x * 7
print(x)`,
  ruby: `x = 6
x = x * 7
puts x`,
  rust: `fn main() {
    let mut x = 6;
    x = x * 7;
    println!("{}", x);
}`,
  typescript: `let x: number = 6;
x = x * 7;
console.log(x);`,
  zig: `const std = @import("std");

pub fn main() void {
    var x: i32 = 6;
    x = x * 7;
    std.debug.print("{d}\\n", .{x});
}`,
};
