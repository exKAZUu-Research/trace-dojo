<?php
gc_disable();
class LeafDestructor {
    function __destruct() { echo 'child;'; }
}
class CycleNode {
    public $link;
    function __construct(public $id, public $change = false) {}
    function __destruct() {
        echo $this->id, ';';
        if ($this->change) $this->link = $this->change === 'replace' ? new LeafDestructor : null;
    }
}
foreach (['replace', 'clear'] as $change) {
    $a = new CycleNode('n1', $change);
    $b = new CycleNode('n2');
    $a->link = $b;
    $b->link = $a;
    unset($a, $b);
    echo 'gc:', gc_collect_cycles(), ';after;', gc_collect_cycles(), "\n";
}
