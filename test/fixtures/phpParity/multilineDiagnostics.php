<?php
$object = new stdClass;
echo $object
    ->missing;
$list = [];
echo $list
    ['missing'];
echo $list[
    'also missing'
];
function returnsType(): int {
    return
        'wrong';
}
try { returnsType(); } catch (TypeError $error) { echo $error->getLine(), "\n"; }
try {
    $denominator = 0;
    $result = 1
        / $denominator;
} catch (Error $error) { echo $error->getLine(), "\n"; }
class Watcher {
    static function trace() { return (new Exception)->getTraceAsString(); }
}
echo Watcher
    ::trace(), "\n";
switch (
    $undefined
) {
    case 1: break;
}
$trace = function () { return (new Exception)->getTraceAsString(); };
echo $trace(
), "\n";
class MagicTrace {
    function __get($key) { echo (new Exception)->getTraceAsString(), "\n"; }
}
$tracedObject = new MagicTrace;
$tracedObject
    ->property;
