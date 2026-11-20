<?php
$a=[]; $a[]=&$a; var_dump(count($a, COUNT_RECURSIVE));
$o = (object)['x' => 1, 'nested' => [2]];
array_walk($o, function(&$v, $k) { if (is_int($v)) $v++; });
array_walk_recursive($o, function(&$v, $k) { $v++; });
var_dump($o->x, $o->nested);
$s = 'abc'; var_dump($s[' 1'], $s['+1'], isset($s['+1']));
$s[' +1 '] = 'x'; var_dump($s);
unset($x->p[0]); $x=null; unset($x->p[0]); echo "ok\n";
class Released { function __destruct() { echo "destroy "; } }
$a=[]; for($i=0;$i<2001;$i++) $a[]=new stdClass();
$x=new Released(); echo ($x=null), "after";
$cycle=[]; $cycle[]=&$cycle;
try { array_walk_recursive($cycle, function(&$v) {}); } catch (Error $e) { echo $e->getMessage(), "\n"; }
