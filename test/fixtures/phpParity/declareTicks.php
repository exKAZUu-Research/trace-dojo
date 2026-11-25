<?php
declare(ticks=1);
$n = 0;
function tick($label) { global $n; $n++; echo "tick $label $n\n"; }
register_tick_function('tick', 'A');
$a = 1;
$b = 2;
echo "x", "y\n";
if ($a) { $c = 3; }
for ($i = 0; $i < 2; $i++) { $d = $i; }
function f() { $z = 1; return $z; }
f();
unregister_tick_function('tick');
$e = 5;
echo "done $n\n";
