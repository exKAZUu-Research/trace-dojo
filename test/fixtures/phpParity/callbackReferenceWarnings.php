<?php
function mapReference(&$x){echo $x,';';$x++;return $x;}
var_dump(array_map('mapReference',[1,2]));
function compareReferences(&$a,&$b){return $a<=>$b;}
$a=[2,1];usort($a,'compareReferences');var_dump($a);
function variadicReferences(&...$x){var_dump($x);}
call_user_func_array('variadicReferences',['foo'=>1]);
function namedReferences(&$a,&$b){var_dump($a,$b);}
call_user_func_array('namedReferences',['b'=>2,'a'=>1]);
$a=[[2,1]];var_dump(array_map('sort',$a),$a);
var_dump(array_map('array_multisort',$a));
function walkReferences(&$value,&$key){$value++;$key=9;}
$a=[1];array_walk($a,'walkReferences');var_dump($a);
