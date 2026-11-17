<?php
$m = new MultipleIterator();
$m->attachIterator(new ArrayIterator([1, 2, 3]));
$m->attachIterator(new ArrayIterator(['a', 'b']));
foreach ($m as $k => $v) { print_r($k); print_r($v); }
$m = new MultipleIterator(MultipleIterator::MIT_NEED_ANY | MultipleIterator::MIT_KEYS_ASSOC);
$m->attachIterator(new ArrayIterator([1, 2, 3]), 'num');
$m->attachIterator(new ArrayIterator(['a', 'b']), 'let');
foreach ($m as $k => $v) { var_dump($k, $v); }
var_dump($m->getFlags(), $m->countIterators());
try { $m->attachIterator(new ArrayIterator([]), 'num'); } catch (Exception $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
$x = new ArrayIterator([]);
$m->attachIterator($x, 5);
var_dump($m->containsIterator($x));
$m->detachIterator($x);
var_dump($m->containsIterator($x), $m->countIterators());
$m->setFlags(MultipleIterator::MIT_KEYS_ASSOC);
$m->attachIterator(new ArrayIterator([9]));
$m->rewind();
try { $m->current(); } catch (Exception $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
$e = new MultipleIterator();
var_dump($e->valid());
try { $e->current(); } catch (Exception $ex) { echo get_class($ex), ': ', $ex->getMessage(), "\n"; }
try { $e->key(); } catch (Exception $ex) { echo get_class($ex), ': ', $ex->getMessage(), "\n"; }
$m = new MultipleIterator();
$m->attachIterator(new ArrayIterator([1]));
$m->attachIterator(new ArrayIterator([]));
$m->rewind();
try { $m->current(); } catch (Exception $ex) { echo get_class($ex), ': ', $ex->getMessage(), "\n"; }
var_dump(MultipleIterator::MIT_NEED_ANY, MultipleIterator::MIT_NEED_ALL, MultipleIterator::MIT_KEYS_NUMERIC, MultipleIterator::MIT_KEYS_ASSOC);
print_r($m); echo "\n";
print_r(array_diff(get_class_methods("MultipleIterator"), ["__debugInfo"]));
print_r(class_implements('MultipleIterator'));
