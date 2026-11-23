<?php
foreach([true,1,'yes',[1],false,0,'0',[]] as $result){echo iterator_apply(new ArrayIterator([1,2,3]),fn()=>$result),"\n";}
$x=1;echo iterator_apply(new ArrayIterator([1,2]),function(&$v){$v++;return 1;},[&$x]),':',$x,"\n";
echo iterator_apply(new ArrayIterator([1,2]),function($a,$b){echo $a,$b;return 'yes';},['b'=>2,'a'=>1]),"\n";
class A{private static function f(){}protected static function g(){}public static function __callStatic($name,$args){echo $name,':',implode(',',$args),';';return true;}}
foreach(['A::f',['A','f'],'A::g',['A','g']] as $f){var_dump(is_callable($f));$f(1,2);call_user_func($f,3,4);echo "\n";}
foreach(['sleep','usleep'] as $fn){try{$fn(-1);echo 'never';}catch(Throwable $e){echo $e->getMessage(),"\n";}var_dump($fn(0));}
