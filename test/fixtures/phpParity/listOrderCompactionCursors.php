<?php $a=['a','b','c','d'];$n=0;foreach($a as $k=>&$v){echo $k,':',$v,';';if($n++===0){unset($a[0],$a[1]);$a['z']='z';ksort($a);}if($n>=4)break;}unset($v);var_dump($a);
