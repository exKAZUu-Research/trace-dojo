<?php
trait T{abstract function f(int $x):int;}
trait U{function f(int $x):int{return $x;}}
trait V{abstract function f(int $x):int;}
class A{use T,U;}
class B{use U,T,V;}
class C{use T;function f(int|float $x):int{return (int)$x;}}
class ParentClass{function f(int $x):int{return $x;}}
class D extends ParentClass{use T;}
foreach([new A,new B,new C,new D] as $o)echo $o->f(2),"\n";
trait P{public $x=null;public array $a=[1];}
trait Q{public $x;public array $a=[1];}
class E{use P,Q;public $x;}
var_dump((new E)->a,(new E)->x);
