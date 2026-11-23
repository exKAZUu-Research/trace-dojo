<?php
class N { public $next; public $v; function __construct($v, $next = null) { $this->v = $v; $this->next = $next; } }
$head = null; for ($i = 0; $i < 4; $i++) $head = new N($i, $head);
var_dump($head);
$head = $head->next; var_dump(new stdClass);
class T { public $children = []; function add($c) { $this->children[] = $c; return $this; } }
$t = (new T)->add(new T)->add((new T)->add(new T)); var_dump($t);
$t = null; var_dump(new stdClass, new stdClass);
$objs = array_map(fn($i) => new N($i), [1, 2, 3]); var_dump($objs);
$objs = array_filter($objs, fn($o) => $o->v != 2); var_dump(new stdClass);
usort($objs, fn($a, $b) => $b->v <=> $a->v); var_dump($objs[0]);
$m = ['x' => new N('x')]; $copy = $m; $copy['y'] = new N('y'); unset($m); var_dump($copy);
$s = (string)(new class { function __toString(): string { return "ts"; } }); var_dump(new stdClass);
$j = json_decode('[{"a":1},{"b":{"c":2}}]'); $j = null; var_dump(new stdClass);
echo "end\n";
