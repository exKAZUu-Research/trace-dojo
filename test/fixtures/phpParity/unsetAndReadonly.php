<?php
$a = ['x' => 1, 'y' => 2]; unset($GLOBALS['a']['x']); var_dump($a);
$a = [[1], [2], [3]]; $i = 0; unset($a[$i++][0]); var_dump($i, $a);
class A { public readonly int $y; function __construct() { $this->y = 1; } }
class B extends A {}
$b = new B;
try { $b->y = 2; } catch (Error $e) { echo $e->getMessage(), "\n"; }
try { unset($b->y); } catch (Error $e) { echo $e->getMessage(), "\n"; }
try { foreach ($b as &$v) {} } catch (Error $e) { echo $e->getMessage(), "\n"; }
$a = ['nested' => ['x' => 1, 'y' => 2]];
$copy = $a;
unset($GLOBALS['a']['nested']['x']);
var_dump($a, $copy);
unset($GLOBALS['a']); var_dump(isset($a));
$a = []; unset($a['missing']['x']); var_dump($a);
$o = (object)['items' => [[1], [2]]]; $i = 0;
unset($o->items[$i++][0]); var_dump($i, $o->items);
class Box implements ArrayAccess {
    public array $data = [[1], [2]];
    public function offsetExists(mixed $key): bool { echo "exists\n"; return isset($this->data[$key]); }
    public function &offsetGet(mixed $key): mixed { echo "get\n"; return $this->data[$key]; }
    public function offsetSet(mixed $key, mixed $value): void { $this->data[$key] = $value; }
    public function offsetUnset(mixed $key): void { unset($this->data[$key]); }
}
$box = new Box; $i = 0; unset($box[$i++][0]); var_dump($i, $box->data);
