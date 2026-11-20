<?php
function make(){return function(){static $n=0;return ++$n;};}
$a=make();$b=make();echo $a(),$a(),$b(),"\n";
$c=clone $a;echo $c(),$a(),"\n";
for($i=0;$i<2;$i++){$h=function(){static $n=0;return ++$n;};echo $h(),$h();}echo "\n";
class T{public int $x;public string $s;}
$t=new T;$v=1;$t->x=&$v;$s='ok';$t->s=&$s;$v=2;echo $t->x,$t->s,"\n";
class D{
 public $x=1;
 function __debugInfo():?array{return null;}
}
var_dump(new D);
