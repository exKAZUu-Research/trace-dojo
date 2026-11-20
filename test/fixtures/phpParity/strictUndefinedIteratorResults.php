<?php
declare(strict_types=1);
function acceptMixed(mixed $value) { var_dump($value); }
class StrictUndefinedChild extends RecursiveArrayIterator {
    function __construct($items, private bool $child = false) { parent::__construct($items); }
    function getChildren(): ?RecursiveArrayIterator { return new self($this->current(), true); }
    function __destruct() {
        if (!$this->child) return;
        global $iterator;
        foreach ([
            fn () => strlen($iterator->getSubIterator()),
            fn () => abs($iterator->getInnerIterator()),
            fn () => acceptMixed($iterator->getSubIterator()),
        ] as $call) {
            try { $call(); }
            catch (TypeError $error) { echo $error->getMessage(), "\n"; }
        }
    }
}
$iterator = new RecursiveIteratorIterator(new StrictUndefinedChild([[1], 2]));
foreach ($iterator as $ignored) {}
