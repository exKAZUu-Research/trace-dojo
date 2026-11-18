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

function returnDuringChild($iterator) {
    foreach ($iterator as $value) return $value;
}
$iterator = new ChildHooks(new DestructibleRecursive([[1], 2]));
foreach ($iterator as $value) { echo "break:$value;"; break; }
echo $iterator->getDepth(), "\n";
echo 'return:', returnDuringChild($iterator), ';', $iterator->getDepth(), "\n";
try {
    foreach ($iterator as $value) throw new Exception('loop');
} catch (Exception $error) { echo $error->getMessage(), ';', $iterator->getDepth(), "\n"; }
echo iterator_apply($iterator, fn () => false), ';', $iterator->getDepth(), "\n";
unset($iterator);
echo "finished;\n";

class ReportsDepth extends RecursiveArrayIterator {
    function __construct($items, private bool $root = false) { parent::__construct($items); }
    function getChildren(): ?RecursiveArrayIterator { return new self($this->current()); }
    function __destruct() {
        global $observed;
        if (!$this->root) echo 'depth:', $observed->getDepth(), ';';
    }
}
$observed = new RecursiveIteratorIterator(new ReportsDepth([[[1]]], true));
foreach ($observed as $value) break;
echo 'after:', $observed->getDepth(), "\n";
try {
    foreach ($observed as $value) throw new Exception('stop');
} catch (Exception $error) { echo 'caught:', $observed->getDepth(), "\n"; }
foreach ($observed as $value) echo 'value:', $value, ';';
echo 'done:', $observed->getDepth(), "\n";
