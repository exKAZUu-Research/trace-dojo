<?php
class Node { public self $next; public ?self $prev; public int $n; public static function make(): static { return new static; } }
class Sub extends Node { public parent $p; }
var_dump(new Node);
var_dump(new Sub);
print_r(new Sub); echo "\n";
