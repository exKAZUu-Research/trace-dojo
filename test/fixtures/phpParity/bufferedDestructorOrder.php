<?php
class BufferedDestructor {
    public $link;
    function __construct(public $id) {}
    function __destruct() { echo $this->id, ','; }
}
$x = new BufferedDestructor('x');
$a = new BufferedDestructor('a');
$y = new BufferedDestructor('y');
$b = new BufferedDestructor('b');
$c = new BufferedDestructor('c');
$b->link = $c;
$a->link = $a;
$c->link = [$b];
unset($a, $b, $c);
gc_collect_cycles();
echo 'end,';
