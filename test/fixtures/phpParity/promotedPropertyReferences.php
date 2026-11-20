<?php
class SharedValue {
    public function __construct(public int &$value) {}
}
$source = 1;
$instance = new SharedValue($source);
$instance->value = 2;
var_dump($source);
$source = 3;
var_dump($instance->value);

class ReadonlyValue {
    public function __construct(
        public readonly int &$value
    ) {}
}
try { new ReadonlyValue($source); }
catch (Error $error) { echo $error->getMessage(), ' on ', $error->getLine(), "\n"; }
