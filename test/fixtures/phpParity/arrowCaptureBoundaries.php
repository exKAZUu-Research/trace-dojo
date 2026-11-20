<?php
class DropAtRelease { function __destruct() { echo 'drop;'; } }
$x = new DropAtRelease;
$uncaptured=fn()=>new class { function method($x) { return $x; } };
unset($x);
echo "after;\n";
$y = 4;
$captured=fn()=>new class($y) {
    function __construct(public int $value) {}
};
$y = 12;
var_dump($captured()->value);
