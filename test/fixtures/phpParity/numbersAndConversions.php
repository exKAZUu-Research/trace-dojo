<?php
$m = PHP_INT_MAX; $m++; var_dump($m); $n = PHP_INT_MIN; $n--; var_dump($n);
var_dump(PHP_INT_MAX * 2, -PHP_INT_MAX, 9223372036854775807 + 0, 0.1 * 3, 1e308 * 10, -1e308 * 10, sqrt(-1));
echo "Arr: " . [1, 2] . "\n";
$arr = [1, 2, 3]; echo "$arr\n";
class W { public static function make() { static $count = 0; return ++$count; } }
echo W::make(), W::make(), "\n";
function f() { try { return "try"; } finally { return "finally"; } } echo f(), "\n";
function g() { foreach ([1, 2, 3] as $v) { try { if ($v == 2) continue; echo $v; } finally { echo "f"; } } echo "\n"; } g();
try { array_map(function($x) { throw new LogicException("in callback $x"); }, [1]); } catch (LogicException $e) { echo $e->getTraceAsString(), "\n"; }
echo str_pad("abc", 2), "|", substr("abc", -5, 2), "|", substr("abc", 1, -5), "|", str_repeat("ab", 0), "|\n";
printf("[%'010.3f] [%-10d] [%+.1e] [%5.1s] [%c%c]\n", -3.14159, -42, 12345.678, "xyz", 80, 72);
echo sprintf("%05d|%5d|%-5d|%x", -42, -42, -42, -42), "\n";
var_dump("1" + "1", "1." + "1", "1" . "1", 7 . '', 1.5 . "", true . "", null . "x");
var_dump(10 <=> 2, "10" <=> "2", "10" <=> "2a", [1, 2] == [2 => 1], null < -1, [] > 0);
$x = ["b" => 1, "a" => 2]; $y = ["a" => 2, "b" => 1]; var_dump($x == $y, $x === $y);
echo implode(",", array_keys(["1" => 'a', "01" => 'b', 1.7 => 'c', true => 'd', null => 'e'])), "\n";
$s = "hello"; $s[10] = "!"; var_dump($s);
$u = "日本"; var_dump(strlen($u), $u[0] === "\xE6", mb_substr($u, 1));
echo ucfirst(strtolower("ÉCOLE")), " ", strtoupper("straße"), " ", mb_strtoupper("straße"), "\n";
var_dump(array_sum([]), array_product([]), max("abc", 0), min([0, "a"]), max([1, "1"]));
list('a' => $aa, 'b' => $bb) = ['b' => 2, 'a' => 1]; echo $aa, $bb, "\n";
$matrix = []; $matrix[1][2] = 'x'; $matrix[1][] = 'y'; print_r($matrix);
$str = "abc"; foreach (str_split($str) as $i => $ch) echo "$i:$ch "; echo "\n";
echo gettype(1 <=> 2), gettype(10 / 2), gettype(10 / 4), gettype(10 % 3), gettype(2 ** 3), gettype(2 ** -1), gettype("5" * 1), "\n";
$fnName = 'str' . 'toupper'; echo $fnName('x'), "\n";
echo PHP_VERSION, " ", PHP_MAJOR_VERSION, " ", M_PI, "\n";
