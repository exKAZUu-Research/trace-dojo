<?php
error_reporting(0);
if (true) {
    class CountResult implements Countable {
        function __construct(private $result) {}
        function count() { return $this->result; }
    }
    class IteratorValidity implements Iterator {
        function __construct(private $result) {}
        function valid() { return $this->result; }
        function rewind(): void {}
        function next(): void {}
        function key(): mixed { return 0; }
        function current(): mixed { return 'value'; }
    }
}
foreach (['2', true, 2.9, null, []] as $result) {
    var_dump(count(new CountResult($result)));
}
foreach ([MultipleIterator::MIT_NEED_ANY, MultipleIterator::MIT_NEED_ALL] as $mode) {
    $multiple = new MultipleIterator($mode);
    $multiple->attachIterator(new IteratorValidity(1));
    var_dump($multiple->valid());
    $multiple->attachIterator(new IteratorValidity(true));
    var_dump($multiple->valid());
}
error_reporting(E_ALL);
function status(callable $call) {
    try { var_dump($call()); }
    catch (Throwable $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
}
$first = [[1, 2]];
$unique = array_unique($first);
$unique[0][0] = 3;
var_dump($first, $unique, array_diff([[1, 2], [3]]));
foreach ([SORT_REGULAR, 99, 'invalid'] as $bad) {
    status(function () use ($bad) { return array_multisort($bad); });
}
foreach ([5, 6, 7, 8] as $mode) {
    var_dump(round(2.5, 0, $mode), round(-0.125, 2, $mode), round(123, -1, $mode));
}
status(fn() => round(1.2, 0, []));
status(fn() => implode([1, 2], null));
status(fn() => implode(separator: [1, 2], array: null));
status(fn() => implode(...[[1, 2], null]));
status(fn() => join([1, 2], null));
status(fn() => implode(['a', 'b']));
status(fn() => implode('-', ['a', 'b']));
$storage = new SplObjectStorage();
status(fn() => isset($storage['bad']));
status(fn() => $storage['bad']);
status(fn() => $storage['bad'] = 1);
status(function () use ($storage) { unset($storage['bad']); });
var_dump(ctype_digit(new stdClass()), ctype_alpha(true));
