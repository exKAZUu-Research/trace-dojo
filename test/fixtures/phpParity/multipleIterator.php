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

class ChangingChild extends ArrayIterator {
    public $onNext;
    public $onRewind;
    function next(): void {
        if ($this->onNext) ($this->onNext)();
        parent::next();
    }
    function rewind(): void {
        if ($this->onRewind) ($this->onRewind)();
        parent::rewind();
    }
}
foreach (['append', 'detach-next', 'detach-current', 'append-labelled', 'rewind'] as $change) {
    $combined = new MultipleIterator;
    $first = new ChangingChild([1, 2]);
    $second = new ArrayIterator([3, 4]);
    $third = new ArrayIterator([5, 6]);
    $combined->attachIterator($first);
    $combined->attachIterator($second);
    if ($change === 'rewind') {
        $third->next();
        $first->onRewind = fn() => $combined->attachIterator($third);
        $combined->rewind();
    } else {
        $first->onNext = match ($change) {
            'append' => fn() => $combined->attachIterator($third),
            'append-labelled' => fn() => $combined->attachIterator($third, 'third'),
            'detach-next' => fn() => $combined->detachIterator($second),
            'detach-current' => fn() => $combined->detachIterator($first),
        };
        $combined->next();
    }
    echo $change, ':', json_encode($combined->current()), ':', $second->current(), ':', $third->current(), "\n";
    $first->onNext = $first->onRewind = null;
}

class ThrowingChild extends ArrayIterator {
    function current(): mixed {throw new Exception('child');}
}
$combined = new MultipleIterator();
$combined->attachIterator(new ThrowingChild([1]));
try { $combined->current(); }
catch (Throwable $error) { echo $error->getMessage(), ':', $error->getPrevious()->getMessage(), "\n"; }
