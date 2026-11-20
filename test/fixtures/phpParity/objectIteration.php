<?php
$o = new stdClass; $o->a = 1; $o->b = 2;
foreach ($o as $k => $v) { if ($k == 'a') $o->c = 3; echo $k, " "; } echo "\n";
foreach ($o as $k => &$v) { if ($k == 'a') $o->d = 4; echo $k, " "; } echo "\n"; unset($v);
class It implements IteratorAggregate { public $arr = [1, 2]; function getIterator(): Iterator { return new ArrayIterator($this->arr); } }
foreach (new It as &$v) { $v *= 2; } echo "done\n";
trait T { function f() { return __METHOD__ . " " . __FUNCTION__ . " " . __CLASS__ . " " . __TRAIT__; } }
class A { use T; } echo (new A)->f(), "\n";
class B { function s(): static { return new B; } } class C extends B {}
try { (new C)->s(); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
class D { public self $me; } print_r(get_object_vars(new D));
