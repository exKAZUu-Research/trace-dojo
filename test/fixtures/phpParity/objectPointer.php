<?php
class Q { public $a = 1; protected $b = 2; private $c = 3; public int $u; public $d = 4; }
$q = new Q;
var_dump(current($q), key($q), next($q), key($q), next($q), key($q), next($q), key($q), next($q), key($q), prev($q), end($q), key($q), reset($q));
try { current(1); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
try { $x = 1; next($x); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
$o = new stdClass; var_dump(current($o), key($o), next($o));
$ao = new ArrayObject([1, 2]); var_dump(current($ao), key($ao));
$o2 = new stdClass; $o2->x = 1; $o2->y = 2; next($o2); $o2->z = 3; var_dump(current($o2), key($o2));
var_dump(array_key_exists(1.5, [1 => 1]));
try { array_key_exists([], []); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
var_dump(array_diff([1, [1], 'a'], ['a'], [[2]]), array_diff([[1]], []), array_diff([], [[1]]), array_diff([[3]], [[3]]));
try { array_diff([1], 1); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
try { array_diff([], 1); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
try { array_rand([]); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
