<?php
class Getter {
    public $values = [1, 2];
    function &__get($name) { echo "get $name\n"; return $this->values; }
}
$getter = new Getter;
unset($getter->virtual[0]);
var_dump($getter->values);
class Overloaded {
    function __get($name) { echo "get $name\n"; return null; }
}
$overloaded = new Overloaded;
unset($overloaded->virtual->property);
unset($overloaded->virtual[0]);
class Ordinary {}
$object = new Ordinary;
unset($object->missing->property);
unset($object->offset[0]);
var_dump($object);
unset($undefined->property);
unset($unassigned->property[0]);
unset($notSet[0]->property);
$integer = 1;
$string = 'abc';
$array = [];
foreach ([
    function () use ($integer) { unset($integer[0]->property); },
    function () use ($string) { unset($string[0]->property); },
    function () use ($string) { unset($string['word']->property); },
    function () use ($array) { unset($array[[]]->property); }
] as $operation) {
    try { $operation(); }
    catch (Error $error) { echo $error->getMessage(), "\n"; }
}
class WithReadonly {
    public readonly array $value;
    function __construct() { $this->value = [1]; }
}
$readonly = new WithReadonly;
try { unset($readonly->value->property); }
catch (Error $error) { echo $error->getMessage(), "\n"; }
