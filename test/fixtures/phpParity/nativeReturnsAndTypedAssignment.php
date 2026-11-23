<?php
class H extends SplMinHeap { public function compare($a,$b):string{return 'x';} }
class T{public int $x=1;public static int $s=1;public float $f=0;}
$t=new T;var_dump($t->x='7',$t->x,$t->f=3,T::$s='9');
$unused; echo "end\n";
