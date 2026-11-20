<?php
class RegexElement {
    function __construct(public int $index) {}
    function __toString(): string { echo "string $this->index\n"; return "a-b"; }
    function __destruct() { echo "release $this->index\n"; }
}
class RegexElements implements Iterator {
    private int $index = 0;
    function rewind(): void { $this->index = 0; }
    function next(): void { echo "advance\n"; $this->index++; }
    function valid(): bool { return $this->index < 2; }
    function current(): mixed { return new RegexElement($this->index); }
    function key(): mixed { return $this->index; }
}
foreach ([
    [RegexIterator::GET_MATCH, 0],
    [RegexIterator::ALL_MATCHES, 0],
    [RegexIterator::SPLIT, 0],
    [RegexIterator::REPLACE, 0],
    [RegexIterator::GET_MATCH, RegexIterator::INVERT_MATCH],
] as [$mode, $flags]) {
    echo "mode $mode flags $flags\n";
    $iterator = new RegexIterator(new RegexElements, '/a/', $mode, $flags);
    $iterator->replacement = 'x';
    foreach ($iterator as $key => $matches) {
        echo "item $key\n";
        if ($mode === RegexIterator::SPLIT) break;
    }
    echo "end of loop\n";
    unset($iterator);
}
