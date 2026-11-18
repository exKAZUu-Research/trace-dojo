<?php
class Item {
    function __construct(public $name) {}
    function __destruct() { echo "-$this->name "; }
}
echo [new Item(1), new Item(2)][1]->name, "|";
$value = [new Item(3), new Item(4)][0];
echo "held|";
unset($value);
echo ['k' => new Item(5)]['k']->name, "|";
[new Item(6)];
echo [new Item(7), 5][1], "|";
var_dump(isset([new Item(8)][0]));
function reference(&$value) { echo "in "; }
function value() { return new Item(9); }
class Factory {
    function value() { return new Item(10); }
    static function staticValue() { return new Item(11); }
}
reference(value()); echo "call|";
reference((new Factory())->value()); echo "method|";
reference(Factory::staticValue()); echo "static|";
reference(new Item(12)); echo "new|";
reference(new class(13) extends Item {}); echo "anonymous|";
var_dump(spl_object_id(new stdClass()));
