<?php
class A{public $a=[1];function get(){return $this->a;}}
$a=new A;$a->get()[]=2;echo 'after;';var_dump($a->a);
$x=[[1]];function f(){global $x;return $x;}f()[0][]=2;var_dump($x);
$x='12';function &integerRef():int{global $x;return $x;}$r=&integerRef();var_dump($x,$r);$r=13;var_dump($x);unset($r);
class B{public $v=1;function &floatRef():float{return $this->v;}}
$b=new B;$r=&$b->floatRef();var_dump($b->v,$r);
class C{public int $v=1;function &floatRef():float{return $this->v;}}
try{$c=new C;$r=&$c->floatRef();var_dump($r,$c->v);}catch(Throwable $e){echo $e->getMessage(),"\n";}
