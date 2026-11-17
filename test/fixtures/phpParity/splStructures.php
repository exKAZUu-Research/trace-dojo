<?php
$s = new SplStack; foreach ([1, 2, 3, 4] as $x) $s->push($x);
var_dump($s[0], $s[3], isset($s[3]), isset($s[4]));
$s[0] = 'top'; unset($s[1]); var_dump($s);
$s->add(1, 'added'); print_r($s); echo "\n";
try { $s['x'] = 1; } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
try { $s['x']; } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
try { unset($s['x']); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
try { $s->add(10, 1); } catch (OutOfRangeException $e) { echo $e->getMessage(), "\n"; }
var_dump($s['1'], $s->getIteratorMode(), method_exists($s, 'toArray'));
$l = new SplDoublyLinkedList; foreach ([1, 2, 3] as $x) $l->push($x);
var_dump($l->setIteratorMode(SplDoublyLinkedList::IT_MODE_DELETE));
foreach ($l as $k => $v) echo "$k=>$v ";
echo count($l), "\n";
foreach ([1, 2, 3] as $x) $l->push($x);
$l->setIteratorMode(SplDoublyLinkedList::IT_MODE_LIFO | SplDoublyLinkedList::IT_MODE_DELETE);
foreach ($l as $k => $v) echo "$k=>$v ";
echo count($l), "\n";
$l->setIteratorMode(0); foreach ([1, 2, 3] as $x) $l->push($x);
$l->rewind(); $l->next(); $l->next(); $l->prev(); var_dump($l->current(), $l->key());
$q = new SplQueue; var_dump($q->setIteratorMode(SplDoublyLinkedList::IT_MODE_DELETE), $q);
$c = clone $s; var_dump(count($c), $c->top());
$pq = new SplPriorityQueue; foreach (range(1, 12) as $i) $pq->insert("v$i", $i % 3);
$out = []; while ($pq->valid()) { $out[] = $pq->current(); $pq->next(); } echo implode(',', $out), "\n";
$pq = new SplPriorityQueue; $pq->insert('a', 1); $pq->insert('b', 2); $pq->insert('c', 2);
var_dump($pq, $pq->getExtractFlags()); print_r($pq); echo "\n";
try { $pq->setExtractFlags(0); } catch (RuntimeException $e) { echo $e->getMessage(), "\n"; }
$h = new SplMinHeap; foreach ([5, 3, 8, 1] as $x) $h->insert($x); var_dump($h);
class Bad extends SplHeap { public $n = 0; protected function compare($a, $b): int { if (++$this->n > 2) throw new Exception('cmp'); return $a <=> $b; } }
$b = new Bad; $b->insert(1); $b->insert(2);
try { $b->insert(3); } catch (Exception $e) { echo $e->getMessage(), "\n"; }
var_dump($b->isCorrupted(), count($b));
try { $b->top(); } catch (RuntimeException $e) { echo $e->getMessage(), "\n"; }
$b->recoverFromCorruption(); var_dump($b->isCorrupted());
$ao = new ArrayObject(['x' => 1]); $it = $ao->getIterator(); $ao['y'] = 2;
var_dump(iterator_to_array($it), $it, json_encode($ao), json_encode(new ArrayIterator([1, 2])));
$ao2 = new ArrayObject($ao); $ao2['z'] = 3; var_dump(count($ao), $ao2);
class O { public $p = 1; }
$ai = new ArrayIterator(['p'=>1]); var_dump(count($ai));
$f = new SplFixedArray(2);
$f[1.0] = 'f'; $f[true] = 't'; var_dump($f[1], $f['1']);
try { $f['-1']; } catch (Throwable $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
