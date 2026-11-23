<?php
class D { public $p; public static $keep; function __construct(public $n) {} function __destruct() { echo "dtor {$this->n}\n"; } function self() { return $this; } }
function id() { return spl_object_id(new stdClass); }
$o = new D("o"); $o->p = new D("p1"); $o->p = new D("p2"); echo id(), "\n";
unset($o->p); echo id(), "\n";
$arr = [new D("a0"), new D("a1")]; $arr[0] = new D("a0b"); unset($arr[1]); echo id(), "\n";
D::$keep = new D("s1"); D::$keep = new D("s2"); echo id(), "\n";
$f = function () use ($o) { return $o->n; }; $o = null; echo $f(), id(), "\n"; $f = null; echo id(), "\n";
echo (new D("chain"))->self()->self()->n, "\n"; echo id(), "\n";
[$l1, $l2] = [new D("l1"), new D("l2")]; $l1 = null; echo id(), "\n";
function tree($d) { $n = new D("t$d"); if ($d > 0) $n->p = tree($d - 1); return $n; } $t = tree(2); $t = null; echo id(), "\n";
$objs = array_map(fn($i) => new D("m$i"), [1, 2]); $objs = array_reverse($objs); $objs = null; echo id(), "\n";
usort($ar2, fn($a, $b) => 0);
$list = [new D("u2"), new D("u1")]; usort($list, fn($a, $b) => strcmp($a->n, $b->n)); array_shift($list); echo id(), "\n";
foreach ([new D("fe")] as &$ref) { $ref = new D("fe2"); } unset($ref); echo id(), "\n";
$c1 = new D("orig"); $c2 = clone $c1; $c1 = null; echo id(), "\n";
try { $tmp = new D("try"); throw new Exception("e"); } catch (Exception $e) { $tmp = null; } echo id(), "\n";
$e = null; echo id(), "\n";
$s = new SplObjectStorage; $s->attach(new D("st")); $s = null; echo id(), "\n";
$ao = new ArrayObject([new D("ao")]); $ao = null; echo id(), "\n";
$str = "x" . id(); echo $str, "\n";
echo "end\n";
