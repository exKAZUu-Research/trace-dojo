<?php
$a = ['x' => 1, 'n' => null]; $a['x'] ??= 2; $a['n'] ??= 3; $a['m'] ??= 4; var_dump($a);
$u ??= 'u'; var_dump($u);
$o = new stdClass; $o->p ??= 5; $o->p ??= 6; var_dump($o);
class M { function __get($n) { echo "get $n\n"; return null; } function __isset($n) { echo "isset $n\n"; return false; } function __set($n, $v) { echo "set $n\n"; } }
$m = new M; $m->q ??= 1;
$s = ['k' => ['z' => null]]; $s['k']['z'] ??= 'deep'; var_dump($s);
class AA implements ArrayAccess { function offsetExists($o): bool { echo "exists\n"; return false; } function offsetGet($o): mixed { echo "get\n"; return null; } function offsetSet($o, $v): void { echo "set\n"; } function offsetUnset($o): void {} }
$aa = new AA; $aa['k'] ??= 1;
