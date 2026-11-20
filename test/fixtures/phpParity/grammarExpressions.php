<?php
namespace Example;

class Constants {
    public const Key = 'value';
    public const Other = self::{'K'.'ey'};
}

$object = new \stdClass;
$object->p = 'P';
$null = null;
echo "[$object?->p][$null?->p]\n";
echo "[$null?->][$null?->1]\n";
echo <<<TEXT
[$object?->p][$null?->p][$null?->]
TEXT, "\n";

$key = 'Key';
var_dump(Constants::{'Key'}, Constants::{strtolower('key') === 'key' ? $key : ''}, Constants::Other);
$name = 'class';
var_dump(Constants::CLASS, Constants::{$name}, (new Constants)::{strtoupper($name)});
foreach ([
    fn() => Constants::{'class'},
    fn() => Constants::{'CL'.'ASS'},
    fn() => Constants::{7},
    fn() => Constants::{new \stdClass},
    fn() => Missing::{constantName()},
    fn() => ('Missing')::{constantName()},
    function () { $class = 'Missing'; return $class::{constantName()}; }
] as $get) {
    try { $get(); } catch (\Throwable $error) { echo $error->getMessage(), "\n"; }
}
function constantName() {
    echo "name evaluated\n";
    return 'Key';
}

$x = 2;
var_dump((int)$x = 1, (string)$x .= 'a', (bool)$x ??= 1);
var_dump((array)$x = 1, (int)$x += 1);
$copy = clone $original = $object;
var_dump($copy == $original, $copy === $original);
$x = 1;
var_dump($y = &$x + 1);
$x = 3;
var_dump($y);
