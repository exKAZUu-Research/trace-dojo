<?php
$o = new stdClass;
$w = WeakReference::create($o);
var_dump($w->get() === $o, $w);
var_dump(WeakReference::create($o) === $w);
unset($o);
var_dump($w->get());
$a = new stdClass; $b = new stdClass; $a->b = $b; $b->a = $a;
$wa = WeakReference::create($a);
unset($a, $b);
var_dump($wa->get() !== null);
gc_collect_cycles();
var_dump($wa->get());
try { new WeakReference(); } catch (Error $e) { echo $e->getMessage(), "\n"; }
try { clone $w; } catch (Error $e) { echo $e->getMessage(), "\n"; }
try { serialize($w); } catch (Exception $e) { echo $e->getMessage(), "\n"; }
$x = new stdClass;
$w2 = WeakReference::create($x);
$x = null;
var_dump($w2->get());
print_r($w2); echo "\n";
var_export($w2); echo "\n";
var_dump($w2 == WeakReference::create(new stdClass));
var_dump(json_encode($w2), (array) $w2);
try { $w2->foo = 1; } catch (Error $e) { echo $e->getMessage(), "\n"; }
