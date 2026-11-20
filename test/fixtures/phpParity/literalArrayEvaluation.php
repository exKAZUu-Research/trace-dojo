<?php
for($i=0;$i<2;$i++){var_dump([1.5&1]);}
trait T{public $values=[__CLASS__];const VALUES=[__CLASS__];function values(){return[__CLASS__];}}
class A{use T;}class B{use T;}$a=new A;$b=new B;var_dump($a->values,$b->values,A::VALUES,B::VALUES,$a->values(),$b->values());
$a=[1,[2]];$b=$a;$a[1][0]=3;var_dump($a,$b);
