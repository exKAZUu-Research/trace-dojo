<?php
abstract class AbstractTraversal implements Traversable {}
class IterableChild extends AbstractTraversal implements IteratorAggregate {
    function getIterator(): Traversable { return new ArrayIterator(['child']); }
}
foreach (new IterableChild() as $value) echo $value, "\n";
class InvalidConcreteChild extends AbstractTraversal {}
