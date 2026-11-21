<?php
class A{function __set(string $name,int $value):void{echo $name,':',$value,"\n";}}
class B{function __set(mixed $name,string $value):void{echo $name,':',$value,"\n";}}
$a=new A;$a->x=1;$b=new B;$b->y='hi';try{$a->x='bad';}catch(Throwable $e){echo $e->getMessage(),"\n";}
