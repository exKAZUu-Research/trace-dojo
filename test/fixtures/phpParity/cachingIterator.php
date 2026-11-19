<?php
$c = new CachingIterator(new ArrayIterator(['a' => 1, 'b' => 2, 'c' => 3]));
foreach ($c as $k => $v) { echo "$k=>$v ", $c->hasNext() ? "more" : "last", " [", (string)$c, "]\n"; }
$c = new CachingIterator(new ArrayIterator(['x', 'y', 'z']), CachingIterator::FULL_CACHE);
foreach ($c as $v) echo $v;
echo "\n";
print_r($c->getCache());
var_dump(count($c), $c['1'], isset($c[2]), $c->offsetExists('5'));
$c['k'] = 'v'; unset($c['0']);
print_r($c->getCache());
var_dump($c->getFlags());
try { echo $c; } catch (Exception $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
$d = new CachingIterator(new ArrayIterator([1]));
try { $d->getCache(); } catch (Exception $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
try { $d->setFlags(0); } catch (Exception $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
try { new CachingIterator(new ArrayIterator([1]), 3); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
$e = new CachingIterator(new ArrayIterator(['k1' => 'v1', 'k2' => 'v2']), CachingIterator::TOSTRING_USE_KEY);
foreach ($e as $v) echo $e, "\n";
$e = new CachingIterator(new ArrayIterator(['k1' => 5]), CachingIterator::TOSTRING_USE_CURRENT);
foreach ($e as $v) echo $e, "\n";
var_dump(CachingIterator::CALL_TOSTRING, CachingIterator::CATCH_GET_CHILD, CachingIterator::TOSTRING_USE_KEY, CachingIterator::TOSTRING_USE_CURRENT, CachingIterator::TOSTRING_USE_INNER, CachingIterator::FULL_CACHE);
$c = new CachingIterator(new ArrayIterator([1, 2]));
var_dump($c->valid(), $c->hasNext(), $c->current());
$c->rewind();
var_dump($c->valid(), $c->hasNext(), $c->current(), $c->key());
print_r($c); echo "\n";
$names = ['a', 'b', 'c'];
$it = new CachingIterator(new ArrayIterator($names));
foreach ($it as $n) { echo $n; if ($it->hasNext()) echo ', '; }
echo "\n";
print_r(class_implements('CachingIterator'));

class CacheValue {
    function __construct(private $label, private $throws = false) {}
    function __destruct() {
        echo "drop:$this->label;";
        if ($this->throws) throw new Exception($this->label);
    }
}
foreach (['rewind', 'enable'] as $mode) {
    $it = new CachingIterator(new ArrayIterator(['fresh' => 3]), CachingIterator::FULL_CACHE);
    $it['a'] = new CacheValue('a', $mode === 'enable');
    $it['b'] = new CacheValue('b', $mode === 'enable');
    $cache = $it->getCache();
    try {
        if ($mode === 'rewind') $it->rewind();
        else {
            $it->setFlags(0);
            $it->setFlags(CachingIterator::FULL_CACHE);
        }
    } catch (Throwable $error) {
        echo $error->getMessage(), ':', $error->getPrevious()?->getMessage(), ';';
    }
    echo $it->getFlags(), ':', json_encode($cache), ':', json_encode($it->getCache()), "\n";
}
$it['old'] = 1;
foreach ($cache as $key => $value) {
    echo "$key:$value;";
    if ($key === 'old') {
        $it->rewind();
        $it['next'] = 2;
    }
}
echo json_encode($cache), "\n";
