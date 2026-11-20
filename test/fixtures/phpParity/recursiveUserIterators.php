<?php
class Node implements RecursiveIterator {
    private $i = 0;
    public function __construct(private array $items) {}
    public function current(): mixed { return $this->items[$this->i]['name']; }
    public function key(): mixed { return $this->i; }
    public function next(): void { $this->i++; }
    public function rewind(): void { $this->i = 0; }
    public function valid(): bool { return $this->i < count($this->items); }
    public function hasChildren(): bool { return !empty($this->items[$this->i]['children']); }
    public function getChildren(): ?RecursiveIterator { return new Node($this->items[$this->i]['children']); }
}
$tree = [
    ['name' => 'root', 'children' => [
        ['name' => 'a', 'children' => [['name' => 'a1'], ['name' => 'a2']]],
        ['name' => 'b'],
    ]],
    ['name' => 'other'],
];
foreach ([RecursiveIteratorIterator::LEAVES_ONLY, RecursiveIteratorIterator::SELF_FIRST, RecursiveIteratorIterator::CHILD_FIRST] as $mode) {
    $it = new RecursiveIteratorIterator(new Node($tree), $mode);
    foreach ($it as $name) echo str_repeat('-', $it->getDepth()), $name, "\n";
    echo "\n";
}
class Bad implements RecursiveIterator {
    private $i = 0;
    public function current(): mixed { return $this->i; }
    public function key(): mixed { return $this->i; }
    public function next(): void { $this->i++; }
    public function rewind(): void { $this->i = 0; }
    public function valid(): bool { return $this->i < 2; }
    public function hasChildren(): bool { return true; }
    public function getChildren(): ?RecursiveIterator { throw new Exception("no kids $this->i"); }
}
foreach (new RecursiveIteratorIterator(new Bad, RecursiveIteratorIterator::SELF_FIRST, RecursiveIteratorIterator::CATCH_GET_CHILD) as $k => $v) echo "$k=>$v\n";
try {
    foreach (new RecursiveIteratorIterator(new Bad, RecursiveIteratorIterator::SELF_FIRST) as $k => $v) echo "$k=>$v\n";
} catch (Exception $e) { echo $e->getMessage(), "\n"; }
class Dir extends RecursiveIteratorIterator {
    function beginChildren(): void { echo str_repeat(' ', $this->getDepth() - 1), "<ul>\n"; }
    function endChildren(): void { echo str_repeat(' ', $this->getDepth() - 1), "</ul>\n"; }
}
foreach (new Dir(new RecursiveArrayIterator(['x' => ['y' => 1, 'z' => ['w' => 2]], 'v' => 3]), RecursiveIteratorIterator::SELF_FIRST) as $k => $v) echo str_repeat(' ', 0), "$k\n";
$rai = new RecursiveArrayIterator([1, [2, [3]]]);
$rii = new RecursiveIteratorIterator($rai);
$rii->rewind();
while ($rii->valid()) { echo $rii->key(), '=', $rii->current(), ' d', $rii->getDepth(), "\n"; $rii->next(); }
$rii->rewind(); $rii->next(); $rii->next();
var_dump($rii->getDepth()); $rii->rewind(); var_dump($rii->getDepth(), $rii->current());
echo implode(',', iterator_to_array(new RecursiveIteratorIterator(new RecursiveArrayIterator(['a' => ['b' => 1, 'c' => 2], 'd' => 3])))), "\n";
function flatten(array $a): array { return iterator_to_array(new RecursiveIteratorIterator(new RecursiveArrayIterator($a)), false); }
print_r(flatten([1, [2, [3, [4]]], 5]));
