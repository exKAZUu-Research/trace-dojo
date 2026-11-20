<?php
class D { public $o; public $list = []; function __construct(public $n) { echo "ctor $n\n"; } function __destruct() { echo "dtor {$this->n}\n"; } }
function id() { return spl_object_id(new stdClass); }
function make($n) { return new D($n); }
$a = make("a"); $b = make("b"); $a = make("a2"); echo id(), "\n";
$list = []; for ($i = 0; $i < 3; $i++) $list[] = new D("l$i"); array_pop($list); echo id(), "\n";
array_shift($list); echo id(), "\n"; $list = null; echo id(), "\n";
$x = new D("x"); $x->o = new D("xo"); $x->list = [new D("xl1"), new D("xl2")]; $x = null; echo id(), "\n";
function scope() { $p = new D("p"); $q = new D("q"); $r = $p; return $q; } $kept = scope(); echo id(), "\n";
$f = function () { $t = new D("t"); }; $f(); echo id(), "\n";
$g = fn($v) => $v->n; echo $g(new D("arg")), "\n"; echo id(), "\n";
$arr = ['k' => new D("k1")]; $arr['k'] = new D("k2"); echo id(), "\n";
$c = clone $kept; $c = null; echo id(), "\n";
foreach ([new D("f1"), new D("f2")] as $item) { echo "in {$item->n}\n"; } echo id(), "\n";
$item = null; echo id(), "\n";
try { $e1 = new D("e"); throw new Exception("boom"); } catch (Exception $e) { echo "caught\n"; } echo id(), "\n";
$s = new SplObjectStorage; $s->attach(new D("s1")); $s = null; echo id(), "\n";
echo "end\n";
