<?php
var_dump((int)STDOUT,(float)STDERR,intval(STDIN),floatval(STDOUT));
$x=1;$a=[&$x];$b=array_combine(['k'],$a);$x=2;var_dump($b);unset($b);var_dump($a);
$keys=['a','b'];$values=[[1],[2]];$combined=array_combine($keys,$values);$values[0][]=3;var_dump($combined,$values);
$a=[1];$a[]=2;$s=new SplObjectStorage;$o=new stdClass;$s->offsetSet($o,$a);$a[]=3;var_dump($s[$o],$a);
$s->rewind();$s->setInfo($a);$a[]=4;var_dump($s[$o],$a);$copy=clone $s;$s[$o]=[5];var_dump($copy[$o],$s[$o]);
class C{public static $x=VALUE;}
try{echo C::$x;}catch(Throwable $e){echo 'caught;';}define('VALUE',3);var_dump(C::$x);
class D{public static $x=1/0;}
for($i=0;$i<2;$i++){try{echo D::$x;}catch(Throwable $e){echo $e->getMessage(),"\n";}}
