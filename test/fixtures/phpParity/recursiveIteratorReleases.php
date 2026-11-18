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
        if ($this->root) return;
        echo 'depth:', $observed->getDepth(), ';';
        var_dump($observed->getSubIterator() === $this, $observed->getInnerIterator() === $this);
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

class ReportsClearedChild extends RecursiveArrayIterator {
    function __construct($items, private bool $child = false) { parent::__construct($items); }
    function getChildren(): ?RecursiveArrayIterator { return new self($this->current(), true); }
    function __destruct() {
        if (!$this->child) return;
        global $observed;
        echo 'cleared at ', $observed->getDepth(), ':';
        var_dump($observed->getSubIterator() === null, $observed->getInnerIterator() === null);
        var_dump($observed->getSubIterator());
        $missing = $observed->getSubIterator();
        echo $missing;
        $replaced = 'old';
        $replaced = $observed->getInnerIterator();
        echo $replaced;
        $alias = &$replaced;
        $alias = $observed->getInnerIterator();
        echo $replaced, $observed->getInnerIterator() ?? 'fallback;';
        $alias = 'new;';
        echo $replaced;
    }
}
$observed = new RecursiveIteratorIterator(new ReportsClearedChild([[1], 2]));
foreach ($observed as $value) echo "value:$value;";
echo "end;\n";

class ReportsIteratorFrames extends RecursiveArrayIterator {
    function __construct($items, private bool $child = false) { parent::__construct($items); }
    function getChildren(): ?RecursiveArrayIterator { return new self($this->current(), true); }
    function __destruct() {
        if (!$this->child) return;
        foreach (debug_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS) as $frame)
            echo ($frame['class'] ?? ''), ($frame['type'] ?? ''), $frame['function'], ':', $frame['line'] ?? 'internal', ';';
        echo "\n";
    }
}
class OverridesIteratorCurrent extends RecursiveIteratorIterator {
    function current(): mixed { return parent::current(); }
}
foreach ([RecursiveIteratorIterator::class, ChildHooks::class, OverridesIteratorCurrent::class] as $class) {
    $iterator = new $class(new ReportsIteratorFrames([[1], 2]));
    foreach ($iterator as $value) {}
}
iterator_to_array(new RecursiveIteratorIterator(new ReportsIteratorFrames([[1], 2])));
class UninitializedRecursiveIterator extends RecursiveIteratorIterator {
    function __construct() {}
}
try {
    foreach (new UninitializedRecursiveIterator() as $value) {}
} catch (Error $error) { echo $error->getMessage(), "\n"; }
