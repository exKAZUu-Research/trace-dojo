<?php
declare(ticks=1);
declare(ticks=1) { echo "in declare block\n"; }
echo print("printed "), "\n";
class P { public static $v = 'P'; public static function get() { return static::$v; } }
class C extends P { public static $v = 'C'; }
class D extends P {}
echo P::get(), C::get(), D::get(), "\n"; D::$v = 'changed'; echo P::$v, C::$v, "\n";
$cls = 'C'; $obj = new $cls(); var_dump($obj instanceof $cls, $obj instanceof P, $cls::get(), $cls::$v);
class M { private $items = [1, 2, 3]; public function doubled() { return array_map([$this, 'twice'], $this->items); } private function twice($x) { return $x * 2; } public function sum() { return array_sum(array_map(fn($x) => $this->twice($x), $this->items)); } public static function triple($x) { return $x * 3; } }
$m = new M; print_r($m->doubled()); echo $m->sum(), "\n";
print_r(array_map('M::triple', [1, 2])); print_r(array_map([M::class, 'triple'], [3]));
$t = M::triple(...); echo $t(5), " "; $s = $m->sum(...); echo $s(), "\n";
$fc = Closure::fromCallable('strtoupper'); echo $fc('abc'), "\n";
class Dbg { private $secret = 'hide'; public $shown = 1; public function __debugInfo() { return ['shown' => $this->shown, 'extra' => true]; } }
var_dump(new Dbg); print_r(new Dbg); echo "\n";
class Agg implements IteratorAggregate { public function getIterator(): Iterator { return new ArrayIterator(['a' => 1, 'b' => 2]); } }
print_r(iterator_to_array(new Agg)); echo iterator_count(new Agg), "\n";
foreach (new Agg as $k => $v) echo "$k$v"; echo "\n";
class Inv { public function __invoke($a, $b) { return $a + $b; } } $inv = new Inv; echo $inv(2, 3), call_user_func($inv, 4, 5), array_sum(array_map($inv, [1, 2], [3, 4])), "\n";
var_dump(is_callable($inv), is_callable('nonexistent'), is_callable('strlen'), is_callable([$m, 'sum']), is_callable([$m, 'twice']));
class Des { public function __construct(public $n) {} public function __destruct() { echo "bye {$this->n}\n"; } }
function scope() { $d = new Des("local"); return "ret"; }
echo scope(), "\n";
$x = new Des("x"); $x = null; echo "after null\n";
$keep = new Des("keep");
$arr = [new Des("e1"), new Des("e2")]; unset($arr[0]); echo "unset one\n"; $arr = []; echo "cleared\n";
exit(0);
