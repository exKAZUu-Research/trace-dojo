<?php
$x=1;var_dump(iterator_apply(new ArrayIterator([1,2,3]),function($v)use(&$x){echo $v;$x++;return true;},[&$x]));echo ':',$x,"\n";
$x=1;iterator_apply(new ArrayIterator([1,2]),function($v)use(&$x){echo $v;$x++;return true;},['v'=>&$x]);echo "\n";
class Changed extends ArrayIterator {function rewind():void {$GLOBALS['x']=8;parent::rewind();}}
$x=1;iterator_apply(new Changed([1]),function($v){echo $v;return true;},[&$x]);echo "\n";
foreach ([[],[1]] as $values) {try {var_dump(iterator_apply(new ArrayIterator($values),fn()=>true,['x'=>1,2]));}catch(Throwable $e){echo $e->getMessage(),"\n";}}
