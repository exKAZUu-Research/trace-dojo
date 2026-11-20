<?php
function cmp($a, $b) { echo "cmp($a,$b) "; return $a <=> $b; }
function kcmp($a, $b) { echo "k($a,$b) "; return strcmp((string)$a, (string)$b); }
$a = ['a' => 'green', 'b' => 'brown', 'c' => 'blue', 'red', 'x' => 'Yellow', 5 => 'blue', 'q' => 'green'];
$b = ['a' => 'GREEN', 'B' => 'brown', 'yellow', 'red', 'c' => 'blue', 9 => 'pink'];
$c = ['green', 'c' => 'blue', 'b' => 'brown', 'zz' => 'red'];
foreach (['array_udiff', 'array_uintersect'] as $f) { echo "$f: "; print_r($f($a, $b, 'cmp')); print_r($f($a, $b, $c, 'cmp')); }
foreach (['array_diff_ukey', 'array_intersect_ukey', 'array_diff_uassoc', 'array_intersect_uassoc'] as $f) { echo "$f: "; print_r($f($a, $b, 'kcmp')); print_r($f($a, $b, $c, 'kcmp')); }
foreach (['array_udiff_uassoc', 'array_uintersect_uassoc'] as $f) { echo "$f: "; print_r($f($a, $b, 'cmp', 'kcmp')); print_r($f($a, $b, $c, 'cmp', 'kcmp')); }
foreach (['array_udiff_assoc', 'array_uintersect_assoc'] as $f) { echo "$f: "; print_r($f($a, $b, 'cmp')); print_r($f($a, $b, $c, 'cmp')); }
$big = range(1, 40); shuffle($big); mt_srand(3); $big = []; for ($i = 0; $i < 40; $i++) $big[] = mt_rand(1, 30);
$big2 = []; for ($i = 0; $i < 25; $i++) $big2["k" . mt_rand(1, 30)] = mt_rand(1, 30);
$n = 0; $count = function ($x, $y) use (&$n) { $n++; return $x <=> $y; };
foreach (['array_udiff', 'array_uintersect', 'array_udiff_assoc', 'array_uintersect_assoc'] as $f) { $n = 0; $r = $f($big, $big2, $count); echo "$f ", count($r), " $n ", json_encode($r), "\n"; }
foreach (['array_diff_ukey', 'array_intersect_ukey', 'array_diff_uassoc', 'array_intersect_uassoc'] as $f) { $n = 0; $r = $f($big2, $big, ['k3' => 1, 4 => 2], $count); echo "$f ", count($r), " $n ", json_encode($r), "\n"; }
var_dump(array_udiff([1, 5, 3], [3], fn($x, $y) => $x > $y));
var_dump(array_diff_uassoc(['a' => 1, 'b' => 2], ['a' => 1], fn($x, $y) => $x < $y));
var_dump(array_uintersect_assoc(['a' => 1, 'b' => 2], ['a' => true], fn($x, $y) => $x == $y));
$r = array_udiff([5 => 1, 6 => 2], [2], 'cmp'); $r[] = 9; var_dump($r);
$r = array_udiff_assoc([5 => 1, 6 => 2], [6 => 2], 'cmp'); $r[] = 9; var_dump($r);
var_dump(array_change_key_case(['A' => 1, 'b' => 2, 3 => 'x', 'B' => 5, 'ÄbC' => 1], CASE_UPPER), array_change_key_case(['A' => 1, 'a' => 2]), CASE_LOWER, CASE_UPPER);
try { array_udiff([2, 1], [], 'invalid array', 'cmp'); }
catch (TypeError $error) { echo $error->getMessage(), "\n"; }
