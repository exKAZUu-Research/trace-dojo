<?php
class T { public int $i = 1; public ?string $s = null; public $u = 1; }
$t = new T;
$r = &$t->i;
$r = "42"; var_dump($t->i);
try { $r = "str"; } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
var_dump($t->i);
function setTo(&$x, $v) { $x = $v; }
try { setTo($t->i, []); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
$a = [&$t->i]; try { $a[0] = 1.5; } catch (TypeError $e) { echo $e->getMessage(), "\n"; } var_dump($t->i);
$q = &$t->u; $q = "anything"; var_dump($t->u);
foreach ([1, 2] as $k) {} $p = &$t->s; $p = 5; var_dump($t->s);
