<?php
class OddFilter extends FilterIterator {
    public function accept(): bool { return $this->current() % 2 == 1; }
}
foreach (new OddFilter(new ArrayIterator([1, 2, 3, 4, 5])) as $k => $v) echo "$k=>$v\n";
$f = new CallbackFilterIterator(new ArrayIterator(['a' => 1, 'b' => 2, 'c' => 3]), function ($v, $k, $it) {
    echo "cb $v $k ", get_class($it), "\n";
    return $v > 1;
});
foreach ($f as $k => $v) echo "$k=>$v\n";
var_dump(iterator_to_array($f));
$f = new CallbackFilterIterator(new ArrayIterator(range(1, 10)), fn($v) => $v % 3 == 0);
echo implode(',', iterator_to_array($f, false)), "\n";
try { $x = new FilterIterator(new ArrayIterator([])); } catch (Error $e) { echo $e->getMessage(), "\n"; }
class Bad extends FilterIterator { function accept(): bool { return true; } function __construct() {} }
try { foreach (new Bad as $v) {} } catch (Error $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
print_r(get_class_methods('CallbackFilterIterator'));
print_r(get_class_methods('FilterIterator'));
print_r($f); echo "\n";
$r = new ReflectionClass('FilterIterator');
