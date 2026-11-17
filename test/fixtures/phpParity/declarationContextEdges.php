<?php
class P {function __construct(public int $x=5){}}
const OBJ=new P(6);echo OBJ->x,"\n";
function f($p=new P(7)){echo $p->x,"\n";static $q=new P(8);echo $q->x,"\n";}f();
class A {function __construct(public private(set) int $ps=1){} }
class C extends A{}
foreach([new A,new C] as $a){try{$a->ps=2;}catch(Throwable $e){echo $e->getMessage(),"\n";}try{$a->ps++;}catch(Throwable $e){echo $e->getMessage(),"\n";}}
