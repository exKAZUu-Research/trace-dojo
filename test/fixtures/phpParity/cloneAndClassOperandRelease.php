<?php
class Operand {
    function __construct(public int $id) {}
    function __clone() { $this->id += 10; }
    function __destruct() { echo "drop $this->id\n"; }
}
function after_operand() { echo "next\n"; return 1; }
function observe($first, $next) { echo "observe\n"; }
observe((new Operand(1))::class, after_operand());
observe(clone (new Operand(2)), after_operand());
