<?php
interface I{public int $x{get;set;}}
class A implements I{public int $x=1;}
interface J{public object $x{get;}}
class B implements J{function __construct(public readonly stdClass $x){}}
interface K{public int $x{set;}}
class C implements K{public mixed $x;}
$a=new A;$a->x=2;var_dump($a->x);
$b=new B(new stdClass);var_dump($b->x instanceof stdClass);
$c=new C;$c->x=3;var_dump($c->x);
