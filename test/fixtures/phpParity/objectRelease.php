<?php
class D { public $o; function __construct(public $n) {} function __destruct() { echo "dtor {$this->n}\n"; } }
$p = new D("p"); $p->o = $p; unset($p); var_dump(gc_collect_cycles());
$a = new D("a"); $b = new D("b"); $a->o = $b; $b->o = $a; unset($a, $b); var_dump(gc_collect_cycles());
$c = new D("c"); $c->o = [$c, [1, 2]]; unset($c); var_dump(gc_collect_cycles());
var_dump(gc_collect_cycles());
$p = new D("p"); $q = new D("q"); unset($p); unset($q);
$arr = [new D("e1"), new D("e2")]; unset($arr);
$arr = [new D("f1"), new D("f2"), new D("f3")]; $arr = [];
function g() { $a = new D("ga"); $b = new D("gb"); return 1; } g(); echo "5\n";
class A {} class B { public $in; function __construct() { $this->in = new A; } }
$x = new B; unset($x); var_dump(new A);
class N { function __construct(public $v) {} }
var_dump(new N(1) < new N(2), new N(1) == new N(1)); var_dump(new N(1));
$h = new D("h"); $h->o = new D("hc"); unset($h);
echo "end\n";
