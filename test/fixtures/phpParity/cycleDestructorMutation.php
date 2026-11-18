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

class LinkMutation {
    public $link;
    function __construct(public $id, public $selfLink = false) {}
    function __destruct() {
        echo $this->id, ';';
        if ($this->id === 'first') {
            $this->link->link = $this->selfLink ? $this->link : null;
        }
    }
}
foreach ([false, true] as $selfLink) {
    $first = new LinkMutation('first', $selfLink);
    $second = new LinkMutation('second');
    $first->link = $second;
    $second->link = $first;
    unset($first, $second);
    echo 'gc:', gc_collect_cycles(), ';after;', gc_collect_cycles(), "\n";
}

class NestedDestructor {
    public $link;
    function __construct(public $id, public $wrap = false) {}
    function __destruct() {
        echo $this->id, ';';
        if ($this->id === 'a') {
            $child = new self('child');
            $this->link = $this->wrap ? [$child] : $child;
        }
    }
}
foreach ([false, true] as $wrap) {
    $a = new NestedDestructor('a', $wrap);
    $b = new NestedDestructor('b');
    $c = new NestedDestructor('c');
    $a->link = $a;
    $b->link = $c;
    $c->link = $b;
    unset($a, $b, $c);
    echo 'gc:', gc_collect_cycles(), ';after;', gc_collect_cycles(), "\n";
}

class ThreeLinkMutation {
    public $next;
    function __construct(public $id, public $replace = false) {}
    function __destruct() {
        echo $this->id, ';';
        if ($this->id === 'one') $this->next = $this->replace ? new self('new') : null;
    }
}
foreach ([false, true] as $replace) {
    $one = new ThreeLinkMutation('one', $replace);
    $two = new ThreeLinkMutation('two');
    $three = new ThreeLinkMutation('three');
    $one->next = $two;
    $two->next = $three;
    $three->next = $one;
    unset($one, $two, $three);
    echo 'gc:', gc_collect_cycles(), ';after;', gc_collect_cycles(), "\n";
}
