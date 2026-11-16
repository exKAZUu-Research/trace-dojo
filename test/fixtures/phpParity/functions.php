<?php
function greet(string $name, string $greeting = "Hello"): string { return "$greeting, $name!"; }
echo greet("A"), greet("B", "Hi"), greet(greeting: "Yo", name: "C"), "\n";
function sum(...$nums) { return array_sum($nums); } echo sum(1, 2, 3), sum(...[4, 5]), "\n";
function addOne(array &$arr) { $arr[] = 1; } $a = []; addOne($a); addOne($a); echo count($a), "\n";
$mul = function($x) use (&$factor) { return $x * $factor; }; $factor = 3; echo $mul(5), "\n";
$byVal = 2; $f = function() use ($byVal) { return $byVal; }; $byVal = 5; echo $f(), "\n";
$arrow = fn($x) => $x + $byVal; echo $arrow(1), "\n";
$compose = fn($f, $g) => fn($x) => $f($g($x)); echo $compose(fn($x) => $x * 2, fn($x) => $x + 1)(5), "\n";
function fact(int $n): int { return $n <= 1 ? 1 : $n * fact($n - 1); } echo fact(20), "\n";
$fn = 'strtoupper'; echo $fn('abc'), call_user_func('str_repeat', 'x', 3), call_user_func_array([new ArrayObject([1,2]), 'count'], []), "\n";
$len = strlen(...); echo $len("hello"), "\n";
function &getRef(array &$arr) { return $arr[0]; } $data = [1, 2]; $r = &getRef($data); $r = 100; print_r($data);
echo implode(",", array_map(fn($x) => $x ** 2, [1, 2, 3])), "\n";
echo implode(",", array_filter([1, 2, 3, 4, 5, 6], fn($x) => $x % 2 == 0)), "\n";
echo array_reduce([1, 2, 3], fn($c, $i) => $c + $i, 10), "\n";
$counter = function() { static $c = 0; return ++$c; }; $counter(); $counter(); echo $counter(), "\n";
function typed(?int $x = null, int|string $y = 5): ?string { return $x === null ? null : "$x$y"; }
var_dump(typed(), typed(1), typed(2, "z"));
function noReturn(): void { return; } var_dump(noReturn());
function withDefault($a, $b = [1, 2], $c = PHP_INT_MAX) { return count($b) . $c; } echo withDefault(1), "\n";
function nums() { return func_get_args(); } print_r(nums(1, 'two', 3.0));
echo (function() { return func_num_args(); })(1, 2, 3), "\n";
$apply = fn(callable $c, ...$args) => $c(...$args); echo $apply('max', 3, 9, 2), "\n";
function recurse($n) { if ($n === 0) return []; return [$n, ...recurse($n - 1)]; } print_r(recurse(3));
try { greet(); } catch (ArgumentCountError $e) { echo $e->getMessage(), "\n"; }
try { greet([]); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
try { greet("x", unknown: 1); } catch (Error $e) { echo $e->getMessage(), "\n"; }
try { undefinedFunction(); } catch (Error $e) { echo $e->getMessage(), "\n"; }
echo strrev("abc"), str_pad("5", 3, "0", STR_PAD_LEFT), "\n";
