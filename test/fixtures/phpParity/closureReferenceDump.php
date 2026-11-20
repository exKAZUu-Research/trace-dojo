<?php
$value = 1;
$closure = function () use (&$value) {};
var_dump($closure);
$value = 2;
var_dump($closure);
unset($value);
var_dump($closure);
class StaticConstant { const VALUE = 8; }
$state = function () {
    static $count = 2 + 3, $items = [1, 2], $pending = strlen('on call');
    if (false) { static $other = StaticConstant::VALUE; }
    ++$count;
};
var_dump($state);
$state();
var_dump($state);
