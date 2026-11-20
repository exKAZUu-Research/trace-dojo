<?php
function defaults($first = 10, $second = 20, $third = 30) { var_dump(func_get_args()); }
defaults(...["second" => 2], ...[1]);
defaults(...new ArrayIterator(["second" => 2]), ...new ArrayIterator([1]));
function variadic($first = 10, $second = 20, &...$rest) {
    var_dump(func_get_args());
    foreach ($rest as &$value) $value++;
}
$values = [1, 2];
variadic(...["second" => 2], ...$values);
var_dump($values);
$closure = function ($first = 10, &$second = null, ...$rest) {
    $second = 9;
    var_dump(func_get_args());
};
$named = ["second" => 2];
$closure->__invoke(...$named, ...[1, 2]);
var_dump($named);
