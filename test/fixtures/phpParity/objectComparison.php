<?php
$a = new stdClass; $b = new stdClass; $a->a = 1;
var_dump($a > $b, $a <=> $b, $b <=> $a, $a == $b);
var_dump([] <=> new stdClass, [] < new stdClass, [] > new stdClass, [1] == new stdClass);
class A { public $x = 1; function __toString(): string { return "10"; } }
var_dump(new A == 1, new A < 2.5, new A == "10", new A == "1e1", new A < "9");
class P { public $p = 1; public $q; }
$p1 = new P; $p2 = new P; $p2->extra = 5; var_dump($p1 <=> $p2, $p2 <=> $p1);
$o = new stdClass; var_dump($o == null, null < $o, $o == true, $o == [], "abc" < new stdClass);
