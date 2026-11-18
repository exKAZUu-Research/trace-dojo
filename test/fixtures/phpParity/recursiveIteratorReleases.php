<?php
class DestructibleRecursive extends RecursiveArrayIterator {
    function __construct($array, private $label = 'root') { parent::__construct($array); }
    function getChildren(): ?RecursiveArrayIterator { return new self([1], 'child'); }
    function __destruct() { echo "destroy:$this->label;"; }
}
class ChildHooks extends RecursiveIteratorIterator {
    function endChildren(): void { echo 'hook:', $this->getDepth(), ';'; }
}
$iterator = new ChildHooks(new DestructibleRecursive([[1], 2]));
foreach ($iterator as $value) echo "value:$value;";
echo "end;\n";
$iterator->rewind();
echo 'again;';
$iterator->rewind();
echo "returned;\n";
unset($iterator);
echo "done;\n";
