<?php
class A{public iterable $x;function f():array|Traversable{return [];}function g(iterable $x):void{echo count((array)$x),';';}}
class B extends A{public array|Traversable $x;function f():iterable{return [1];}function g(array|Traversable $x):void{echo count((array)$x),';';}}
class C{public array|Traversable $x;}
class D extends C{public iterable $x;}
class E{public ?iterable $x;}
class F extends E{public array|Traversable|null $x;}
$b=new B;$b->x=[1];var_dump($b->f(),$b->x);$b->g([1,2]);$d=new D;$d->x=[];var_dump($d->x);$f=new F;$f->x=null;var_dump($f->x);
