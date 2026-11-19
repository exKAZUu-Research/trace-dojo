<?php
error_reporting(E_ALL & ~E_DEPRECATED);
class MethodResult {
    function __construct(public string $label) {}
    function __destruct() { echo "drop $this->label\n"; }
}
class ResultIterator extends ArrayIterator {
    function rewind() {
        parent::rewind();
        return [new MethodResult("rewind")];
    }
    function valid() {
        return parent::valid() ? new MethodResult("valid") : false;
    }
    function next() {
        parent::next();
        return [new MethodResult("next")];
    }
    function seek($offset) {
        parent::seek($offset);
        return [new MethodResult("seek")];
    }
}
foreach ([new ResultIterator([1, 2]), new IteratorIterator(new ResultIterator([1, 2]))] as $iterator) {
    foreach ($iterator as $item) echo "item $item\n";
}
$limit = new LimitIterator(new ResultIterator([1, 2]), 1);
$limit->rewind();
echo "limited item ", $limit->current(), "\n";
$multiple = new MultipleIterator;
$multiple->attachIterator(new ResultIterator([1, 2]));
$multiple->attachIterator(new ResultIterator([3, 4]));
$multiple->rewind();
var_dump($multiple->valid());
$multiple->next();
var_dump($multiple->valid());
class ResultTraversal extends RecursiveIteratorIterator {
    function beginIteration() { return new MethodResult("begin iteration"); }
    function callHasChildren() {
        return parent::callHasChildren() ? [new MethodResult("has children")] : false;
    }
    function beginChildren() { return new MethodResult("begin children"); }
    function nextElement() { return [new MethodResult("next element")]; }
    function endChildren() { return new MethodResult("end children"); }
    function endIteration() { return [new MethodResult("end iteration")]; }
}
foreach (new ResultTraversal(new RecursiveArrayIterator([[1], [2]])) as $item) echo "item $item\n";
class InterruptedMethodResult {
    function __destruct() { echo "interrupt\n"; throw new Exception("interrupted"); }
}
class InterruptedTraversal extends RecursiveIteratorIterator {
    function callHasChildren() {
        return parent::callHasChildren() ? new InterruptedMethodResult : false;
    }
}
$interrupted = new InterruptedTraversal(
    new RecursiveArrayIterator([[1], 2]),
    RecursiveIteratorIterator::LEAVES_ONLY,
    RecursiveIteratorIterator::CATCH_GET_CHILD
);
foreach ($interrupted as $item) echo "item after interruption $item\n";

class ResultAccess implements ArrayAccess {
    function offsetExists($key) { return [new MethodResult("exists $key")]; }
    function offsetGet($key): mixed { echo "get $key\n"; return $key; }
    function offsetSet($key, $value) { return new MethodResult("set $key"); }
    function offsetUnset($key) { return [new MethodResult("unset $key")]; }
}
$access = new ResultAccess;
var_dump(isset($access[1]), $access[2] ?? 0, $access[3] = 8);
unset($access[1], $access[2]);
$direct = $access->offsetSet(3, 0);
echo "direct return: $direct->label\n";
unset($direct);

class ResultHeap extends SplPriorityQueue {
    public bool $extracting = false;
    function compare($left, $right) {
        if (!$this->extracting) return $left <=> $right;
        echo "compare\n";
        return [new MethodResult("comparison")];
    }
}
$heap = new ResultHeap;
foreach (range(1, 7) as $item) $heap->insert($item, $item);
$heap->extracting = true;
echo "extracted ", $heap->extract(), "\n";
