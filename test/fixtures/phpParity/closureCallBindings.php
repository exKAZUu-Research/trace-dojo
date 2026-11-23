<?php
class Receiver { public $value = 9; }
$static = static function () { echo "static-body\n"; };
var_dump($static->call(new Receiver()));
$ordinary = function () { echo "body:", $this->value, "\n"; };
var_dump($ordinary->call(new stdClass()));
var_dump($ordinary->call(new Receiver()));
$f = function (&$x, $y = 2, &...$rest) { $x += $y; foreach ($rest as &$item) $item++; };
$x = 1;
$tail = 10;
$f->__invoke($x, y: 3, tail: $tail);
var_dump($x, $tail);
$f->__invoke(x: $x);
var_dump($x);
$callback = [$f, "__invoke"];
$callback($x, 1);
var_dump($x);
call_user_func_array($callback, [&$x, 2]);
var_dump($x);
function refValue(&$value) { echo "new-body:", get_class($value), "\n"; }
refValue(new stdClass());
refValue(new class {});
