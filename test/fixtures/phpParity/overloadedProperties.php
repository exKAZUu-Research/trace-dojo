<?php
class M { private $d = []; function __get($n) { echo "get($n)\n"; return $this->d[$n] ?? []; } function __set($n, $v) { echo "set($n)\n"; $this->d[$n] = $v; } function __isset($n) { echo "isset($n)\n"; return true; } }
$m = new M;
$m->arr[] = 2;
$m->arr['k'] = 3;
var_dump($m->arr);
class Arr { private $d = ['list' => [1]]; function &__get($n) { return $this->d[$n]; } }
$ar = new Arr; $ar->list[] = 2; var_dump($ar->list);
class AA implements ArrayAccess { private $c = []; function offsetExists($o): bool { echo "exists\n"; return isset($this->c[$o]); } function offsetGet($o): mixed { echo "get $o\n"; return $this->c[$o] ?? []; } function offsetSet($o, $v): void { echo "set $o\n"; $this->c[$o] = $v; } function offsetUnset($o): void {} }
$aa = new AA; $aa['k'][] = 2; $aa['k'] = [1]; $aa['k'][] = 5;
class I { function __isset($n) { echo "isset($n)\n"; return true; } function __get($n) { echo "get($n)\n"; return new I2; } }
class I2 { public $x = 1; }
$i = new I; var_dump(isset($i->m->x)); var_dump(isset($i->m['k'])); var_dump(empty($i->m->x));
