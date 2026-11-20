<?php
$o = new stdClass; $o->a = 1; $o->self = $o; $o->b = 2;
var_export($o);
echo "\n---\n";
$a = [1, 2]; $a[] = &$a;
var_export($a);
echo "\n---\n";
$s = var_export($o, true);
echo "after\n";
echo $s, "\n";
class P { public $x; public $y; }
$p = new P; $p->x = $p; $p->y = [$p];
var_export($p);
echo "\n";
