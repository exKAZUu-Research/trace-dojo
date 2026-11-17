<?php
var_dump(json_validate("\"\xff\"",flags:JSON_INVALID_UTF8_IGNORE));
var_dump(json_decode("\"a\xffb\"",flags:JSON_INVALID_UTF8_SUBSTITUTE));
const DATE_FORMAT='Y-m-d';echo DATE_FORMAT,"\n";
class T {public static int $x=1; public float $f=0; public int $i=1;}
$t=new T; $r=&$t->f; $r=NAN;var_dump(is_nan($t->f));
$s=1;T::$x=&$s;try{$s='hello';}catch(TypeError $e){echo $e->getMessage(),"\n";}
settype($t->i,'string');var_dump($t->i);
var_dump(is_callable('missing_function',true,$name),$name,is_resource(STDOUT),is_object(STDOUT));
$x=1; $a=['x'=>&$x];$b=array_merge($a);$c=array_values($a);$x=2;var_dump($b,$c);
$names=[];$names[]=&$names;try{compact($names);}catch(Error $e){echo $e->getMessage(),"\n";}

try {T::$x=&$r;}catch(TypeError $e){echo $e->getMessage(),"\n";}
