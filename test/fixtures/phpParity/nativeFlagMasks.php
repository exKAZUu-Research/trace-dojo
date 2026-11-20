<?php
$large = 9007199254740993;
$cache = new CachingIterator(new ArrayIterator(['abc']), $large);
$cache->rewind();
var_dump((string) $cache, $cache->getFlags());
$cache->setFlags($large);
var_dump($cache->getFlags());
foreach ([ArrayObject::class, ArrayIterator::class] as $class) {
    $array = new $class([], $large);
    var_dump($array->getFlags());
    $array->setFlags($large + 4);
    var_dump($array->getFlags());
}
$queue = new SplPriorityQueue;
$queue->insert('value', 11);
var_dump($queue->setExtractFlags($large), $queue->top());
var_dump($queue->setExtractFlags(PHP_INT_MAX), $queue->top());

function traceOptions(string $argument, int $flags): void {
    debug_print_backtrace($flags);
}
traceOptions('visible', 9007199254740993);
traceOptions('omitted', 9007199254740995);
traceOptions('omitted', PHP_INT_MAX);

$iterator = new RegexIterator(new ArrayIterator(['abc' => 'zzz']), '/abc/', RegexIterator::MATCH, $large, $large + 2);
var_dump($iterator->getFlags(), $iterator->getPregFlags());
foreach ($iterator as $key => $value) echo "$key=$value\n";
$iterator->setFlags(PHP_INT_MAX);
$iterator->setPregFlags(-9007199254740993);
var_dump($iterator->getFlags(), $iterator->getPregFlags());

class ThrowingChildren extends RecursiveArrayIterator {
    function getChildren(): ?RecursiveArrayIterator { throw new Exception('child'); }
}
foreach ([PHP_INT_MAX, PHP_INT_MAX - 1, 0] as $flags) {
    $children = new ThrowingChildren([[1]]);
    $iterator = new RecursiveIteratorIterator($children, RecursiveIteratorIterator::SELF_FIRST, $flags);
    try {
        foreach ($iterator as $item) echo "item;";
        echo "done\n";
    } catch (Exception $error) {
        echo $error->getMessage(), "\n";
    }
}

$iterator = new ArrayIterator(['first' => 1, 'second' => 2]);
foreach ([9007199254740993, PHP_INT_MAX, -9007199254740993, 1] as $offset) {
    try {
        $iterator->seek($offset);
    } catch (OutOfBoundsException $error) {
        echo $error->getMessage(), "\n";
    }
    var_dump($iterator->key());
}

$storage = new SplObjectStorage;
$storage->attach(new stdClass, 'first');
$storage->attach(new stdClass, 'second');
foreach ([1, 9007199254740993, PHP_INT_MAX, -9007199254740993] as $offset) {
    try {
        $storage->seek($offset);
    } catch (OutOfBoundsException $error) {
        echo $error->getMessage(), "\n";
    }
    var_dump($storage->key());
}
