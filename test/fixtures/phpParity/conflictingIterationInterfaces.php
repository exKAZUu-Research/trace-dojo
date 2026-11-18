<?php
class Both extends ArrayObject implements Iterator {
    function current(): mixed { return 1; }
    function key(): mixed { return 1; }
    function next(): void {}
    function rewind(): void {}
    function valid(): bool { return false; }
}
echo 'unexpected';
