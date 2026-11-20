<?php
$a = 1; $b = &$a; $b++; echo "$a $b\n";
$arr = [1, 2, 3]; foreach ($arr as &$v) { $v *= 2; } unset($v); print_r($arr);
$c = $arr; $c[] = 4; echo count($arr), count($c), "\n";
function counter() { static $n = 0; $n++; return $n; }
echo counter(), counter(), counter(), "\n";
$g = 10; function useGlobal() { global $g; $g++; return $g; } echo useGlobal(), $g, "\n";
function viaGlobals() { return $GLOBALS['g'] * 2; } echo viaGlobals(), "\n";
$name = 'dyn'; $$name = 'dynamic'; echo $dyn, " ", ${'dy' . 'n'}, "\n";
$x = null; echo isset($x) ? 'set' : 'unset', isset($undef) ? 'y' : 'n', empty($x) ? 'E' : 'e', "\n";
$data = ['k' => ['n' => 5]]; echo $data['k']['n'] ?? 'none', $data['z']['n'] ?? 'none', "\n";
$q = $q ?? 'default'; echo $q, "\n";
$m = []; $m['a']['b'][] = 1; $m['a']['b'][] = 2; print_r($m);
$s = 'hello'; $s[0] = 'H'; echo $s, $s[-1], strlen($s), "\n";
$i = 5; $j = $i++ + ++$i; echo "$i $j\n";
list($p, list(, $r)) = [1, [2, 3]]; echo $p, $r, "\n";
['x' => $xx, 'y' => $yy] = ['y' => 'Y', 'x' => 'X']; echo $xx, $yy, "\n";
[$a1, $b1] = [$b1 ?? 'B', 'A']; echo $a1, $b1, "\n";
$swap1 = 1; $swap2 = 2; [$swap1, $swap2] = [$swap2, $swap1]; echo $swap1, $swap2, "\n";
$ref = [1, 2]; $copy = $ref; $r0 = &$ref[0]; $r0 = 9; print_r($ref); print_r($copy);
echo gettype(1), gettype(1.0), gettype("s"), gettype(true), gettype([]), gettype(null), gettype(new stdClass), "\n";
var_dump((int)"12.7", (float)"3.5abc", (bool)"0", (bool)"", (bool)"0.0", (string)false, (array)"x", intval("0x1A", 0), intval("012", 0), intval("101", 2));
var_dump(PHP_INT_MAX + 1, -PHP_INT_MAX - 2, 0.1 + 0.2 == 0.3, abs(-5), 7 <=> 3);
const GREETING = "hi"; define('ANSWER', 42); echo GREETING, ANSWER, defined('ANSWER') ? 'd' : 'u', constant('GREETING'), "\n";
echo __LINE__, "\n";
