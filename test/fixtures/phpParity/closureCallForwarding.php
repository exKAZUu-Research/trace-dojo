<?php
class Receiver { private $value = 9; }
$h = function ($a, $b = "d") { return "$a$b" . static::class; };
echo $h->call(new Receiver(), b: "B", a: "A"), "\n";
$g = function (&$value) { $value = $this->value; };
$value = 0;
$g->call(new Receiver(), $value);
var_dump($value);
$g->call(new Receiver(), value: $value);
var_dump($value);
