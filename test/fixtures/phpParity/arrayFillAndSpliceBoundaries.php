<?php
foreach ([[PHP_INT_MAX,2],[PHP_INT_MAX-1,3],[PHP_INT_MAX,1],[PHP_INT_MAX,0],[-2,4]] as [$start,$count]) {try {var_dump(array_fill($start,$count,1));}catch(Throwable $e){echo get_class($e),':',$e->getMessage(),"\n";}}
foreach ([null,(object)['a'=>1,'b'=>2],new stdClass,7,'x',false,[8,9]] as $replacement) {$a=[1,2,3];var_dump(array_splice($a,1,1,$replacement),$a);}
