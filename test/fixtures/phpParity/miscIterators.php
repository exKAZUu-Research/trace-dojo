<?php
$ap = new AppendIterator();
$ap->append(new ArrayIterator([1, 2]));
$ap->append(new ArrayIterator([]));
$ap->append(new ArrayIterator(['a' => 3]));
foreach ($ap as $k => $v) echo "$k=>$v idx=", $ap->getIteratorIndex(), "\n";
var_dump($ap->getIteratorIndex(), get_class($ap->getArrayIterator()), count($ap->getArrayIterator()));
var_dump(iterator_to_array($ap, false));
$ap2 = new AppendIterator();
var_dump($ap2->valid(), $ap2->current(), $ap2->key(), $ap2->getIteratorIndex());
$nr = new NoRewindIterator(new ArrayIterator([1, 2, 3]));
foreach ($nr as $v) { echo $v; break; }
foreach ($nr as $v) echo $v;
echo "\n";
$a = new ArrayIterator([1, 2, 3]);
$a->next();
foreach (new NoRewindIterator($a) as $k => $v) echo "$k=>$v\n";
$inf = new InfiniteIterator(new ArrayIterator(['x', 'y']));
$n = 0;
foreach ($inf as $k => $v) { echo "$k$v "; if (++$n >= 5) break; }
echo "\n";
foreach (new LimitIterator(new InfiniteIterator(new ArrayIterator([1, 2, 3])), 0, 7) as $v) echo $v;
echo "\n";
$e = new EmptyIterator();
foreach ($e as $v) echo "never\n";
var_dump($e->valid());
try { $e->current(); } catch (Exception $x) { echo get_class($x), ': ', $x->getMessage(), "\n"; }
try { $e->key(); } catch (Exception $x) { echo get_class($x), ': ', $x->getMessage(), "\n"; }
var_dump(iterator_count(new EmptyIterator()));
print_r(class_implements('EmptyIterator'));
print_r(class_implements('AppendIterator'));
print_r(get_class_methods('AppendIterator'));
var_dump($ap);
