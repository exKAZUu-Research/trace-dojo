<?php
class Item {
    function __construct(public $name) {}
    function __destruct() { echo $this->name; }
}
$flag = false;
if ($flag) new class($a, $c) { function __construct($x, $y) {} };
$b = new Item("b");
$a = new Item("a");
$c = new Item("c");
$values = [];
new class($values[]) { function __construct(&$x) { $x = 3; } };
new class(value: $values[]["x"]) { function __construct(&$value) { $value = 4; } };
new class(...[&$values[0]]) { function __construct(&$value) { $value++; } };
var_dump($values);
