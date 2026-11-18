<?php
class Entries implements Iterator {
    private $position = 0;
    function rewind(): void { $this->position = 0; }
    function valid(): bool { return $this->position < 3; }
    function key(): mixed { return $this->position === 0 ? "x" : $this->position; }
    function current(): mixed { echo "read", $this->position, "\n"; return $this->position; }
    function next(): void { $this->position++; }
}
function collect(...$values) { var_dump($values); }
try { collect(...new Entries()); } catch (Throwable $error) { echo $error->getMessage(), "\n"; }
collect(...["x" => 1], ...[2]);
collect(...new ArrayIterator(["x" => 1]), ...new ArrayIterator([2]));
function mutate(&$value, &...$rest) { $value = 99; foreach ($rest as &$item) $item = 99; }
$items = new ArrayIterator([1]);
mutate(...$items);
var_dump($items[0]);
$items = new ArrayIterator(["value" => 2, "tail" => 3]);
mutate(...$items);
var_dump($items["value"], $items["tail"]);
function reorder($first, &$second) {}
$first = ["second" => 0];
try { reorder(...$first, ...[5]); }
catch (Throwable $error) { echo get_class($error), ": ", $error->getMessage(), "\n"; }
var_dump($first);
