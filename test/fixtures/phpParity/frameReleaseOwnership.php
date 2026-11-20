<?php
class Dropped {
    function __construct(public int $id) {}
    function __destruct() { echo "drop $this->id\n"; }
}
function viaList() {
    $a = new Dropped(1);
    $b = new Dropped(2);
    $items = [$b, $a];
}
function viaArguments(...$items) {
    array_shift($items);
    echo "return\n";
}
function viaAliases($a, $b) {
    $first = $b;
    $last = $a;
}
viaList();
viaArguments(new Dropped(3), new Dropped(4));
viaAliases(new Dropped(5), new Dropped(6));
