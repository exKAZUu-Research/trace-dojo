<?php
function t() { echo "T\n"; }
register_tick_function('t');
declare(ticks=1);
$f = function () { echo "in closure\n"; };
$f();
$g = fn() => 1;
echo "x", "y", "\n";
global $zz, $yy;
unset($a, $b);
static $s = 1;
const K = 1;
;
{ $inner = 1; }
?>
html
<?php
echo "end\n";
