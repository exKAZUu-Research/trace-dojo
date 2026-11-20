<?php
class Node {
    public $next;
    public $previous;
    function __construct(public $name) {}
    function __destruct() { echo "$this->name;"; }
}
$root = new stdClass();
$root->head = $root->tail = new Node("first");
for ($i = 0; $i < 4; $i++) {
    $next = new Node("node$i");
    $next->previous = $root->tail;
    $root->tail->next = $next;
    $root->tail = $next;
}
unset($next);
$root->head = null;
$root->tail = null;
echo "before-gc;";
echo gc_collect_cycles(), "\n";
$root->head = $root->tail = new Node("a");
for ($i = 0; $i < 3; $i++) {
    $next = new Node("b$i");
    $root->tail->next = $next;
    $root->tail = $next;
}
unset($next);
$root->tail = null;
$root->head = $root->head->next;
echo "advanced;";
$root->head = null;
echo "cleared\n";
