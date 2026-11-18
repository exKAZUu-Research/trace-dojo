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
interface RequiresMethods { function one(); function two(); }
new class implements RequiresMethods {};
