<?php
class A{public float $x=1.5;function &f():int{return $this->x;}}
class B{public float $x=2.5;function &f():int{return $this->x;}}
class C{public int|string $x="12";function &f():int{return $this->x;}}
class S{function __toString(){echo 'convert';return 'x';}}
class D{public S|string $x;function __construct(){$this->x=new S;}function &f():string{return $this->x;}}
foreach([new A,new B,new C,new D] as $a){try{$r=&$a->f();}catch(Throwable $e){echo $e->getMessage(),"\n";}var_dump($a->x);}
function &plain():int{static $x=1.5;return $x;}$r=&plain();var_dump($r);
