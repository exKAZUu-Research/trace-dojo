<?php
$s = new SplStack(); $s->push(1); $s->push(2); $s->push(3); echo $s->pop(), $s->top(), count($s), "\n";
foreach ($s as $v) echo $v; echo "\n";
$q = new SplQueue(); $q->enqueue('a'); $q->enqueue('b'); $q[] = 'c'; echo $q->dequeue(), count($q), $q[0], "\n";
foreach ($q as $k => $v) echo "$k=$v "; echo "\n";
$h = new SplMinHeap(); foreach ([5, 1, 3] as $x) $h->insert($x); echo $h->extract(), $h->top(), count($h), "\n";
$mh = new SplMaxHeap(); foreach ([5, 1, 3] as $x) $mh->insert($x); foreach ($mh as $v) echo $v; echo count($mh), "\n";
$pq = new SplPriorityQueue(); $pq->insert('low', 1); $pq->insert('high', 10); $pq->insert('mid', 5); while (!$pq->isEmpty()) echo $pq->extract(), " "; echo "\n";
$fa = new SplFixedArray(3); $fa[0] = 'x'; echo $fa->getSize(), $fa[0], var_export($fa[1], true), "\n"; print_r($fa->toArray());
try { $fa[5] = 1; } catch (RuntimeException $e) { echo get_class($e), ": ", $e->getMessage(), "\n"; }
$os = new SplObjectStorage(); $o1 = new stdClass; $o2 = new stdClass; $os->attach($o1, 'one'); $os->attach($o2); $os[$o2] = 'two'; echo count($os), $os[$o1], $os->contains($o2) ? 'Y' : 'N', "\n";
$ao = new ArrayObject(['b' => 2, 'a' => 1]); $ao['c'] = 3; echo count($ao), "\n"; $ao->ksort(); print_r($ao->getArrayCopy());
foreach ($ao as $k => $v) echo "$k$v"; echo "\n";
$it = new ArrayIterator([10, 20, 30]); foreach ($it as $k => $v) echo "$k:$v "; echo count($it), "\n";
try { (new SplStack)->pop(); } catch (RuntimeException $e) { echo $e->getMessage(), "\n"; }
try { (new SplMinHeap)->extract(); } catch (RuntimeException $e) { echo $e->getMessage(), "\n"; }
print_r(iterator_to_array(new ArrayIterator(['x' => 1, 'y' => 2])));
var_dump(new ArrayObject([1]));
