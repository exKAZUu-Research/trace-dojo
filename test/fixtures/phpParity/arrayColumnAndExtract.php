<?php
class M { private $p = 'priv'; public $n = null; public function __isset($k) { return $k === 'v'; } public function __get($k) { return "magic-$k"; }
  static function col($rows) { return array_column($rows, 'p'); } }
$rows = [new M, new M];
var_dump(array_column($rows, 'p'), array_column($rows, 'n'), array_column($rows, 'v'), M::col($rows));
try { var_dump(array_column([['a' => 1, 'k' => [1]]], 'a', 'k')); } catch (Throwable $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
var_dump(array_column([['a' => 1, 'k' => '5'], ['a' => 2, 'k' => 'x'], ['a' => 3, 'k' => false]], 'a', 'k'));
function g() {
  $arr = ['a' => 1, 'b' => 2, 0 => 'z', 'this' => 3, '1x' => 4];
  var_dump(extract($arr, EXTR_PREFIX_ALL, 'p'), $p_a, $p_0, $p_this);
  var_dump(extract($arr, EXTR_PREFIX_INVALID, 'q'), $q_0, $q_1x, $q_this);
  var_dump(extract(['a' => 9, 'this' => 1, 'c' => 3], EXTR_PREFIX_SAME, 'r'), $a, $r_a, $r_this, $c);
  var_dump(extract(['a' => 10, 'zz' => 3], EXTR_IF_EXISTS), $a);
  var_dump(extract(['a' => 11, 'zz' => 3], EXTR_PREFIX_IF_EXISTS, 's'), $s_a);
  var_dump(extract(['this' => 1], EXTR_SKIP));
  $src = ['m' => 1, 'n' => 2]; $copy = $src;
  var_dump(extract($src, EXTR_REFS | EXTR_PREFIX_ALL, 'w')); $w_m = 7; var_dump($src, $copy);
  try { extract(['this' => 1]); } catch (Error $e) { echo $e->getMessage(), "\n"; }
  try { extract(['a' => 1], 99); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
  try { extract(['a' => 1], EXTR_PREFIX_ALL); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
  try { extract(['a' => 1], EXTR_PREFIX_ALL, '1'); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
  var_dump(extract(['k' => 5], EXTR_REFS), $k);
}
g();

foreach ( [[[], [], null], [[], 'key', []]] as $args) {
    try { array_column(...$args); }
    catch (TypeError $error) { echo $error->getMessage(), "\n"; }
}

foreach ([127, 128] as $byte) {
    $first = chr($byte) . 'a';
    $last = 'b' . chr($byte);
    var_dump(extract([$first => 1, $last => 1]), isset(${$first}), isset(${$last}));
    try { var_dump(extract(['key' => 1], EXTR_PREFIX_ALL, chr($byte))); }
    catch (ValueError $error) { echo $error->getMessage(), "\n"; }
}
