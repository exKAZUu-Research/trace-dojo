<?php
trait T{function f(){return[1];}}class A{use T;}class B{use T;}
$a=new A;$b=new B;$x=$a->f();unset($x,$a);$x=$b->f();unset($x,$b);
class N{public $self;}for($i=0;$i<12000;$i++){$n=new N;$n->self=$n;}var_dump(new stdClass);echo gc_collect_cycles(),"\n";
