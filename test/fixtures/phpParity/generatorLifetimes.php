<?php
class A { function m() { yield 1; } function __destruct() { echo "A gone\n"; } }
$x = (new A)->m();
echo "1\n";
unset($x);
echo "2\n";
$c = function() { yield 1; };
$y = $c();
unset($y);
var_dump(new stdClass);
function inner2() { yield 1; return 'r'; }
function outer2() { $r = yield from inner2(); var_dump(new stdClass); yield 3; }
foreach (outer2() as $k => $v) echo "$k=$v\n";
var_dump(new stdClass);
function o3() { $i = inner2(); foreach ($i as $v) yield $v; unset($i); var_dump(new stdClass); }
foreach (o3() as $v) {}
