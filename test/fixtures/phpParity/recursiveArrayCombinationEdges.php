<?php
foreach (['array_merge_recursive','array_replace','array_replace_recursive'] as $f) {
    echo $f,"\n";
    $x=1;$a=['k'=>&$x];$r=$f($a,['k'=>2]);$x=3;var_dump($x,$a,$r);
    $x=1;$b=['k'=>&$x];$r=$f(['k'=>2],$b);$x=3;var_dump($r);
    $x=['a'=>1];$a=['k'=>&$x];$r=$f($a,['k'=>['b'=>2]]);var_dump($x,$a,$r);
}
foreach (['array_merge_recursive','array_replace_recursive'] as $f) {
    $a=[];$a['x']=&$a;
    try {$f($a,$a);}catch(Throwable $e){echo $f,':',$e->getMessage(),"\n";}
    $x=1;$b=[&$x];$r=$f([],$b);$x=2;var_dump($r);
    $shared=['x'=>1];$a=['a'=>&$shared,'b'=>&$shared];try {$r=$f($a,$a);var_dump($r);}catch(Throwable $e){echo $e->getMessage(),"\n";}
    $shared=['x'=>1];$a=['a'=>$shared,'b'=>$shared];var_dump($f($a,$a));
}
foreach ([null,(object)['a'=>1]] as $base) {
    foreach ([2,['b'=>2]] as $incoming) var_dump(array_merge_recursive(['k'=>$base],['k'=>$incoming]));
}
