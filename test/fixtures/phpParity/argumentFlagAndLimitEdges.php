<?php
function writeVariadic(&...$x){foreach($x as &$v)$v=2;}
$a=[];writeVariadic(foo:$a[],x:$a[]);var_dump($a);
function readVariadic(...$x){}
echo 'before;';try{readVariadic(foo:$a[]);}catch(Throwable $e){echo $e->getMessage(),"\n";}
echo 'before;';try{readVariadic(x:$a[]);}catch(Throwable $e){echo $e->getMessage(),"\n";}
foreach(range(0,15) as $flag){$a=['b','A'];try{array_multisort($a,$flag);echo $flag,':',implode(',',$a),"\n";}catch(Throwable $e){echo get_class($e),': ',$e->getMessage(),"\n";}}
$a=[2,1];try{array_multisort($a,11,SORT_ASC);}catch(Throwable $e){echo $e->getMessage(),"\n";}
function outerLimit($a){innerLimit('x');}
function innerLimit($x){foreach([-1,0,1] as $limit){echo $limit,':',count(debug_backtrace(0,$limit)),"\n";debug_print_backtrace(0,$limit);}}
outerLimit(2);
