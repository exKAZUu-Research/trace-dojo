<?php
class ArrayKeyChild extends RecursiveArrayIterator {
    function __construct($array, private bool $child = false) { parent::__construct($array); }
    function getChildren(): ?RecursiveArrayIterator { return new self($this->current(), true); }
    function __destruct() {
        if (!$this->child) return;
        global $iterator;
        $compare = function ($a, $b) {
            echo "(", $a, ",", $b, ")";
            return $a <=> $b;
        };
        var_dump(array_intersect_ukey([1, 2], [$iterator->getSubIterator(), 5], $compare));
    }
}
$iterator = new RecursiveIteratorIterator(new ArrayKeyChild([[1], 2]));
foreach ($iterator as $ignored) {}
