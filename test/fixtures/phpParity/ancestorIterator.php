<?php
class BaseIteratorFactory implements IteratorAggregate {
    function getIterator(): Traversable { echo self::class,':',static::class,"\n"; return new ArrayIterator([1]); }
}
class MiddleIteratorFactory extends BaseIteratorFactory {
    function getIterator(): Traversable { echo self::class,':',static::class,"\n"; return new ArrayIterator([2]); }
}
class LeafIteratorFactory extends MiddleIteratorFactory {}
foreach ([BaseIteratorFactory::class, MiddleIteratorFactory::class, null, IteratorAggregate::class] as $factory) {
    try { var_dump(iterator_to_array(new IteratorIterator(new LeafIteratorFactory, $factory))); }
    catch (Throwable $e) { echo get_class($e),': ',$e->getMessage(),"\n"; }
}
