<?php
class D { public $p; function __construct(public $n) {} function __destruct() { echo "dtor {$this->n}\n"; } function getClosure() { return function () { return $this->n; }; } }
function id() { return spl_object_id(new stdClass); }
$a = new D("a"); $r = &$a; $a = new D("a2"); echo id(), "\n"; unset($r); echo id(), "\n"; unset($a); echo id(), "\n";
function counter() { static $s; $s = new D("static" . id()); return 1; } counter(); counter(); echo id(), "\n";
$g = new D("g"); function useG() { global $g; $g = new D("g2"); } useG(); echo id(), "\n";
$cl = (new D("cl"))->getClosure(); echo $cl(), id(), "\n"; $cl = null; echo id(), "\n";
$list = [new D("x1"), new D("x2"), new D("x3")]; $list = array_filter($list, fn($d) => $d->n != "x2"); echo id(), "\n";
$list = array_values($list); $list = array_merge($list, [new D("x4")]); $list = null; echo id(), "\n";
$nested = ['a' => ['b' => new D("nb")], 'c' => new D("nc")]; $nested['a'] = null; echo id(), "\n"; $nested = null;
class Thrower { function __destruct() { echo "thrower dtor\n"; throw new Exception("from dtor"); } }
try { $t = new Thrower; $t = null; } catch (Exception $e) { echo "caught ", $e->getMessage(), "\n"; } echo id(), "\n";
$e = null;
function make2() { $x = new D("mk1"); $y = new D("mk2"); return [$y, $x]; } $pair = make2(); echo id(), "\n"; $pair = null; echo id(), "\n";
$q = new D("q"); $q->p = $q; $q = null; echo id(), "\n";
$w = new D("w"); $w2 = $w; $w = null; echo id(), "\n"; $w2 = new D("w3"); echo id(), "\n";
echo "end\n";
