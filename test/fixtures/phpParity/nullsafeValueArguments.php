<?php
function referenceArgument(&$value) { $value++; }
class ArgumentClass {
    public $property = 1;
    public function &method() {
        echo 'called', "\n";
        return $this->property;
    }
}
$object = new ArgumentClass;
foreach ([fn() => referenceArgument($object?->property), fn() => referenceArgument($object?->method())] as $call) {
    try { $call(); } catch (Error $error) { echo $error->getMessage(), "\n"; }
}
var_dump($object->property);
$object = null;
try { referenceArgument($object?->property); } catch (Error $error) { echo $error->getMessage(), "\n"; }
