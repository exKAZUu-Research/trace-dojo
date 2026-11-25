<?php
class A { public $x { get => yield 1; } }
$a = new A; foreach ($a->x as $v) echo $v, "\n";
class B { public iterable $x { get { yield 1; yield 2; } } }
foreach ((new B)->x as $v) echo $v, "\n";
