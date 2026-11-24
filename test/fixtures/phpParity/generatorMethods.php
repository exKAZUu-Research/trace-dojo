<?php
function g() { try { $x = yield 1; echo "x=$x\n"; $y = yield 2; echo "y=$y\n"; } catch (Exception $e) { echo "caught ", $e->getMessage(), "\n"; yield 99; } finally { echo "finally\n"; } return 'done'; }
$gen = g();
var_dump($gen->send('A'));
var_dump($gen->throw(new Exception('boom')));
var_dump($gen->valid());
$gen->next();
var_dump($gen->valid(), $gen->getReturn());
try { $gen->rewind(); } catch (Exception $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
try { foreach ($gen as $v) {} } catch (Exception $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
$g2 = g();
try { $g2->getReturn(); } catch (Exception $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
$g2->next();
try { $g2->rewind(); } catch (Exception $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
try { foreach ($g2 as $v) {} } catch (Exception $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
function thrower() { yield 1; throw new RuntimeException('inside'); }
$t = thrower();
foreach ($t as $v) { echo $v, "\n"; break; }
try { $t->next(); } catch (RuntimeException $e) { echo "caught: ", $e->getMessage(), " line ", $e->getLine(), "\n"; }
var_dump($t->valid(), $t->current(), $t->key());
try { $t->getReturn(); } catch (Exception $e) { echo $e->getMessage(), "\n"; }
function selfish() { global $s; yield $s->current(); }
$s = selfish();
try { $s->current(); } catch (Error $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
try { new Generator(); } catch (Error $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
try { clone g(); } catch (Error $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
$closed = g(); foreach ($closed as $v) {}
var_dump($closed->send(5), $closed->current());
try { $closed->throw(new LogicException('late')); } catch (LogicException $e) { echo "late caught\n"; }
var_dump(g() instanceof Traversable, g() instanceof Iterator, iterator_to_array((function() { yield 'a' => 1; yield 'b' => 2; })()));
var_dump(iterator_to_array((function() { yield 1; yield 2; yield from [3, 4]; })(), false));
