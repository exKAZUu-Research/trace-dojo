<?php
$l = new SplDoublyLinkedList();
foreach ([1, 2, 3] as $v) $l->push($v);
$l->add(1, 'x'); $l->add(4, 'end'); $l->add(0, 'start');
foreach ($l as $k => $v) echo "$k=$v ";
echo "\n";
$l->setIteratorMode(SplDoublyLinkedList::IT_MODE_LIFO);
foreach ($l as $k => $v) echo "$k=$v ";
echo "\n", $l->getIteratorMode(), "\n";
$l->setIteratorMode(SplDoublyLinkedList::IT_MODE_FIFO | SplDoublyLinkedList::IT_MODE_DELETE);
foreach ($l as $k => $v) echo "$k=$v ";
echo "\n", count($l), "\n";
$l->push('a'); $l->push('b'); $l->push('c');
$l->setIteratorMode(0);
$l->rewind(); $l->next(); $l->next(); echo $l->current(); $l->prev(); echo $l->current(), "\n";
try { $l->add(10, 'z'); } catch (OutOfRangeException $e) { echo $e->getMessage(), "\n"; }
$s = new SplStack; try { $s->setIteratorMode(0); } catch (RuntimeException $e) { echo $e->getMessage(), "\n"; }
$ao = new ArrayObject(['x' => 1, 'y' => [2]]);
echo json_encode($ao), "\n";
var_dump((array) $ao);
$ao->setFlags(ArrayObject::STD_PROP_LIST);
var_export($ao); echo "\n";
echo json_encode($ao), "\n";
var_dump((array) $ao, count($ao));
var_dump($ao);
