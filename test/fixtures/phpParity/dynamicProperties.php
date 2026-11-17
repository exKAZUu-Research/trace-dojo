<?php
$a = new ArrayObject([1]); $a->x = 1;
class MyAO extends ArrayObject {} $m = new MyAO([1]); $m->y = 2;
$s = new SplStack; $s->z = 3;
class B {} class A { function __construct(public $b) {} }
var_dump(new A(new B));
var_export(new ArrayObject([1, 'k' => 2])); echo "\n";
