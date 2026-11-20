<?php
class A{function __debugInfo():array{return ['x'=>1];}function __isset(string|int $name):true{return true;}function __get(mixed $name):int{return 3;}}
$a=new A;var_dump($a,isset($a->x),$a->x);
class B{static function __set_state(array $values):self{return new self;}}
var_dump(B::__set_state([]) instanceof B);
