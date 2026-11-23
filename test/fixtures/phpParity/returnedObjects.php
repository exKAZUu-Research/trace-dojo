<?php
class D { function __construct(public $n) {} function __destruct() { echo "dtor {$this->n}\n"; } }
function make() { return new D(1); }
$x = make();
echo "after make\n";
class F { static function mk() { return new D(2); } function inst() { return new D(3); } }
$y = F::mk();
$z = (new F)->inst();
echo "after methods\n";
function make2() { $d = new D(4); return $d; }
$w = make2();
echo "end\n";
