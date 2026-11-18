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
