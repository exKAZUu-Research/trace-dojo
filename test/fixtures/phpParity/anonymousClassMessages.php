<?php
$object = new class {
    public $value = 1;
    function needsInt(int $number) {}
    function needsRef(&$value) {}
    function trace() { return (function () { return (new Exception)->getTraceAsString(); })(); }
};
try { $object->needsInt('bad'); }
catch (TypeError $error) { echo $error->getMessage(), "\n"; }
try { $object->needsRef(1); }
catch (Error $error) { echo $error->getMessage(), "\n"; }
echo $object->trace(), "\n";
echo var_export($object, true), "\n";
try { throw new class('message') extends RuntimeException {}; }
catch (RuntimeException $error) { echo $error, "\n"; }
$typed = new class {
    function takesOne(int $value): string { return []; }
    function closure() { return function (int $value): string { return []; }; }
};
foreach ([
    fn () => $typed->takesOne(1),
    fn () => $typed->takesOne(),
    fn () => $typed->closure()('bad'),
    fn () => $typed->closure()(),
    fn () => $typed->closure()(1),
] as $call) {
    try { $call(); }
    catch (TypeError $error) { echo $error->getMessage(), "\n"; }
}
interface RequiresMethods { function one(); function two(); }
new class implements RequiresMethods {};
