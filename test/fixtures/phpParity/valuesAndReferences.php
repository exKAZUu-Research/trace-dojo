<?php
$s = "hello";
echo $s[-10] ?? 'd', "\n";
var_dump(isset($s[-6]), isset($s[-5]), $s[-5]);
echo $s[-6], "|\n";
var_dump($s[-6]);
echo $s[7], "|\n";
$e = "";
$e[0] = "a";
var_dump($e);
$f = "";
$f[2] = "x";
var_dump($f);
$g = "ab";
$g[-3] = "z";
var_dump($g);
$h = "";
try { $h[] = "x"; } catch (Error $ex) { echo get_class($ex), ": ", $ex->getMessage(), "\n"; }
$k = "";
try { $k["k"] = 1; } catch (Error $ex) { echo get_class($ex), ": ", $ex->getMessage(), "\n"; }
$m = "abc";
try { $m["k"] = 1; } catch (Error $ex) { echo get_class($ex), ": ", $ex->getMessage(), "\n"; }
var_dump($m);
echo 1 ?: 2 ?: 3, "\n";
echo 0 ?: 0 ?: 3, "\n";
echo null ?: "" ?: "x" ?: "y", "\n";
echo (true ? 1 : 2) ? 3 : 4, "\n";
var_dump(preg_match('/\p{L}/u', 'a'));
var_dump(preg_match_all('/\p{Han}+/u', '漢字とかな、カタカナ', $m), $m);
var_dump(preg_match('/^\p{Hiragana}+$/u', 'ひらがな'));
var_dump(preg_match('/^\p{Katakana}+$/u', 'カタカナ'));
var_dump(preg_replace('/\P{L}+/u', '-', 'a1b2 c'));
var_dump(preg_match('/\pL\pN/u', 'x9'));
var_dump(preg_match('/[\p{Lu}]/u', 'abC'));
var_dump(preg_match('/\p{^Lu}/u', 'A'));
var_dump(preg_match('/\x{3042}/u', 'あ'));
var_dump(preg_match('/\x{41}/', 'A'));
var_dump(preg_match('/(?<n>a)\k{n}/', 'aa'), preg_match("/(?<n>a)\\k'n'/", 'aa'));
var_dump(preg_split('/[\s\p{P}]+/u', 'Hello, world! こんにちは。', -1, PREG_SPLIT_NO_EMPTY));
var_dump(preg_match('/\p{L}/', 'a'));
var_dump(preg_match('/\p{Xan}+/u', 'ab12'));
$x = 1; $a = [&$x, 2]; var_dump($a);
$b = [1, 2]; $r = &$b[0]; var_dump($b); unset($r); var_dump($b);
$c = [1, 2, 3]; foreach ($c as &$v) {} var_dump($c); unset($v); var_dump($c);
$d = []; $rr = &$d['x']; var_dump($d);
function f(&$p) {} $e = [1]; f($e[0]); var_dump($e);
$o = new stdClass; $o->p = 1; $rp = &$o->p; var_dump($o);
$n = ['in' => [1]]; $q = &$n['in']; var_dump($n);
$g = [1]; $h = &$g; var_dump($g);
$a = [5 => 'a']; array_pop($a); $a[] = 'x'; var_dump($a);
$b = [0 => 'a', 5 => 'b', 1 => 'c']; array_pop($b); $b[] = 'x'; var_dump($b);
$c = [1, 2, 3]; array_pop($c); $c[] = 'x'; var_dump($c);
$d = [-5 => 'x']; $d[] = 'y'; var_dump($d);
$e = [-3 => 1, -10 => 2]; $e[] = 3; var_dump($e);
$f = ['a' => 1]; $f[] = 2; var_dump($f);
$g = [-5 => 'x']; array_pop($g); $g[] = 1; var_dump($g);
$h = []; $h[-2] = 1; unset($h[-2]); $h[] = 2; var_dump($h);
$i = [-7 => 1]; $j = $i; $j[] = 2; var_dump($j, array_merge($i, [3]));
$k = [-5 => 1]; $k2 = array_slice($k, 0, 1, true); $k2[] = 2; var_dump($k2);
var_dump(array_fill(-5, 3, 'v'));
function a(array $x) {} try { a(true); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
function r(): array { return false; } try { r(); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
$b = true; try { $b->foo(); } catch (Error $e) { echo $e->getMessage(), "\n"; }
echo $b->p ?? '', "\n"; echo @$b->p; var_dump($b->p);
try { $b->p = 1; } catch (Error $e) { echo $e->getMessage(), "\n"; }
class X { public int $p = 0; } $xx = new X; try { $xx->p = true; $xx->p = []; } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
var_dump($b[0]);
foreach ($b as $v) {}
try { strlen([]); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
try { count(true); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
try { array_keys(false); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
try { var_dump(true + []); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
try { var_dump(~true); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
try { $s = "abc"; var_dump($s[[]]); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
class S { function __toString(): string { return "x"; } }
try { $c = true; new $c; } catch (Error $e) { echo $e->getMessage(), "\n"; }
try { exit(true); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
$c = true;
try { echo $c::X; } catch (Error $e) { echo $e->getMessage(), "\n"; }
try { $c::m(); } catch (Error $e) { echo $e->getMessage(), "\n"; }
try { $n = 5; new $n; } catch (Error $e) { echo $e->getMessage(), "\n"; }
try { $a = []; new $a; } catch (Error $e) { echo $e->getMessage(), "\n"; }
var_dump(9007199254740993 == 9007199254740992.0, PHP_INT_MAX == (float)PHP_INT_MAX, 9007199254740993 <=> 9007199254740992.0);
var_dump(PHP_INT_MAX < PHP_INT_MAX + 1, 1 == 1.0, 2 < 2.5, -1 > -1.5, 3 <=> 3.0);
var_dump("9007199254740993" == "9007199254740992.0", "9007199254740993" == 9007199254740992.0, "9007199254740993" == "9007199254740992");
var_dump(max(9007199254740993, 9007199254740992.0), in_array(9007199254740993, [9007199254740992.0]));
var_dump(NAN == 1, 1 < NAN, NAN <=> 1);
$a = [3, 2.5, 9007199254740993, 9007199254740992.0, 1]; sort($a); var_dump($a);
$o = new stdClass; $o->me = $o; $r = &$o->me; var_dump($o);
$a = [1]; $a[] = &$a; var_dump($a);
