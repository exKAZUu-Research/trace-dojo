<?php
class A { function __construct(public $n) { echo "ctor $n\n"; } function __destruct() { echo "dtor {$this->n}\n"; } }
function f() { $x = new A("local"); echo "in f\n"; }
$a = new A("a");
$b = new A("b");
$c = [new A("c1"), new A("c2")];
f();
$b = null;
new A("temp");
echo "after temp\n";
$d = new A("d");
$e = $d;
$o = new A("o"); $o->self = $o; unset($o);
echo "end\n";
