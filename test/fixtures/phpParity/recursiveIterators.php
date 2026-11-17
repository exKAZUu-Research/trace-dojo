<?php
$data = ['a' => 1, 'b' => ['c' => 2, 'd' => ['e' => 3]], 'f' => 4];
foreach (new RecursiveIteratorIterator(new RecursiveArrayIterator($data)) as $k => $v) echo "$k=>$v\n";
echo "--self\n";
$it = new RecursiveIteratorIterator(new RecursiveArrayIterator($data), RecursiveIteratorIterator::SELF_FIRST);
foreach ($it as $k => $v) echo str_repeat('  ', $it->getDepth()), $k, is_array($v) ? '' : "=$v", "\n";
echo "--child\n";
$it = new RecursiveIteratorIterator(new RecursiveArrayIterator($data), RecursiveIteratorIterator::CHILD_FIRST);
foreach ($it as $k => $v) echo $it->getDepth(), " ", $k, is_array($v) ? '' : "=$v", "\n";
echo "--max\n";
$it = new RecursiveIteratorIterator(new RecursiveArrayIterator($data), RecursiveIteratorIterator::SELF_FIRST);
$it->setMaxDepth(0);
var_dump($it->getMaxDepth());
foreach ($it as $k => $v) echo $k, "\n";
$it->setMaxDepth(-1);
var_dump($it->getMaxDepth());
var_dump(iterator_to_array(new RecursiveIteratorIterator(new RecursiveArrayIterator([[1, 2], [3, [4, 5]]])), false));
class Hooks extends RecursiveIteratorIterator {
    function beginIteration(): void { echo "beginIteration\n"; }
    function endIteration(): void { echo "endIteration\n"; }
    function beginChildren(): void { echo "beginChildren ", $this->getDepth(), "\n"; }
    function endChildren(): void { echo "endChildren ", $this->getDepth(), "\n"; }
    function nextElement(): void { echo "nextElement\n"; }
    function callHasChildren(): bool { $r = parent::callHasChildren(); echo "hasChildren ", var_export($r, true), "\n"; return $r; }
}
foreach (new Hooks(new RecursiveArrayIterator([1, [2, 3], 4])) as $k => $v) echo "$k=>$v\n";
$o = new stdClass; $o->p = 1;
foreach (new RecursiveIteratorIterator(new RecursiveArrayIterator([1, (array)$o, [2]])) as $k => $v) echo "$k=>", is_object($v) ? 'obj' : $v, "\n";
foreach (new RecursiveIteratorIterator(new RecursiveArrayIterator([1, $o, [2]], RecursiveArrayIterator::CHILD_ARRAYS_ONLY)) as $k => $v) echo "$k=>", is_object($v) ? 'obj' : $v, "\n";
var_dump(RecursiveArrayIterator::CHILD_ARRAYS_ONLY, RecursiveIteratorIterator::LEAVES_ONLY, RecursiveIteratorIterator::SELF_FIRST, RecursiveIteratorIterator::CHILD_FIRST, RecursiveIteratorIterator::CATCH_GET_CHILD);
$r = new RecursiveArrayIterator([1, [2]]);
var_dump($r->hasChildren()); $r->next(); var_dump($r->hasChildren()); print_r($r->getChildren());
try { new RecursiveIteratorIterator(new ArrayIterator([])); } catch (Exception $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
try { foreach (new RecursiveIteratorIterator(new ArrayObject([1, [2, 3]])) as $v) echo $v; } catch (Exception $e) { echo get_class($e), ": ", $e->getMessage(), "\n"; }
echo "\n";
$it = new RecursiveIteratorIterator(new RecursiveArrayIterator([1, [2]]));
foreach ($it as $v) { echo get_class($it->getInnerIterator()), ' ', get_class($it->getSubIterator()), ' ', $it->getSubIterator(0)->key(), "\n"; }
var_dump($it->getSubIterator(5));
print_r(get_class_methods('RecursiveIteratorIterator'));
print_r(class_implements('RecursiveIteratorIterator'));
print_r(class_implements('RecursiveArrayIterator'));
print_r($it); echo "\n";
print_r(new RecursiveArrayIterator([1]));
