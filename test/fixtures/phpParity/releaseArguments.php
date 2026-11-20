<?php
class D { function __construct(public $n) {} function __destruct() { echo "dtor {$this->n}\n"; } function __toString(): string { return "str{$this->n}"; } }
function id() { return spl_object_id(new stdClass); }
function take($a, $b) { $loc = new D("loc"); echo "in take\n"; return 7; }
echo take(new D("arg1"), new D("arg2")), "\n"; echo id(), "\n";
function pass($x) { return $x; } $kept = pass(new D("passed")); echo id(), "\n";
echo "x" . new D("concat") . "y", "\n"; echo id(), "\n";
$s = (string) new D("cast"); echo $s, id(), "\n";
var_dump(new D("cmp1") == new D("cmp2")); echo id(), "\n";
for ($i = 0; $i < 3; $i++) { $loop = new D("it$i"); } echo id(), "\n";
foreach ([1, 2] as $v) { $tmp = [new D("arr$v")]; } echo id(), "\n";
$fn = fn($o) => $o->n . "!"; echo $fn(new D("arrow")), "\n"; echo id(), "\n";
class Fac { static function make($n) { return new D($n); } } $m = Fac::make("fac"); $m = Fac::make("fac2"); echo id(), "\n";
$x = [new D("e1")]; $y = $x; $x[0] = new D("e2"); echo id(), "\n"; $y = null; echo id(), "\n";
echo "end\n";
