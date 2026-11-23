<?php
class Item {
    public $next;
    function __construct(public $name, public $fails) {}
    function __destruct() { echo "$this->name;"; if ($this->fails) throw new Exception($this->name); }
}
foreach ([false, true] as $both) {
    $a = new Item("first", true);
    $b = new Item("second", $both);
    $a->next = $b;
    $b->next = $a;
    unset($a, $b);
    try { gc_collect_cycles(); } catch (Throwable $error) {
        do { echo "caught:", $error->getMessage(), ";"; $error = $error->getPrevious(); } while ($error);
    }
    echo "after;", gc_collect_cycles(), "\n";
}
