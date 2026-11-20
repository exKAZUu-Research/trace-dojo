<?php
$a = new stdClass; $b = new stdClass; $c = new stdClass;
$s1 = new SplObjectStorage; $s1[$a] = 1; $s1[$b] = 2;
$s2 = new SplObjectStorage; $s2[$b] = 'B'; $s2[$c] = 'C';
var_dump($s1->addAll($s2));
foreach ($s1 as $i => $o) echo $i, ' ', $s1[$o], "\n";
var_dump($s1->removeAll($s2), count($s1));
$s1->addAll($s2);
var_dump($s1->removeAllExcept($s2), count($s1));
var_dump($s1->getHash($a) === spl_object_hash($a), strlen($s1->getHash($a)));
$s = new SplObjectStorage; $s[$a] = 1; $s[$b] = 2; $s[$c] = 3;
$s->rewind(); $s->next(); $s->next();
var_dump($s->key());
unset($s[$a]);
var_dump($s->key(), $s->valid());
$s->seek(1); var_dump($s->key(), $s->getInfo());
try { $s->seek(5); } catch (OutOfBoundsException $e) { echo $e->getMessage(), "\n"; }
class Subj implements SplSubject {
    private $obs;
    public $state = 0;
    function __construct() { $this->obs = new SplObjectStorage; }
    function attach(SplObserver $o): void { $this->obs[$o] = null; }
    function detach(SplObserver $o): void { unset($this->obs[$o]); }
    function notify(): void { foreach ($this->obs as $o) $o->update($this); }
}
class Obs implements SplObserver {
    function __construct(private string $n) {}
    function update(SplSubject $s): void { echo $this->n, " got ", $s->state, "\n"; }
}
$sub = new Subj; $o1 = new Obs('one'); $o2 = new Obs('two');
$sub->attach($o1); $sub->attach($o2); $sub->state = 5; $sub->notify();
$sub->detach($o1); $sub->state = 6; $sub->notify();
var_dump($sub instanceof SplSubject, $o1 instanceof SplObserver);
print_r(class_implements($sub));
print_r(array_diff(get_class_methods("SplObjectStorage"), ["__debugInfo"]));
