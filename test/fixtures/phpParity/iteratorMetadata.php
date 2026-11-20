<?php
foreach (['IteratorIterator', 'FilterIterator', 'CallbackFilterIterator', 'LimitIterator', 'CachingIterator', 'NoRewindIterator', 'AppendIterator', 'InfiniteIterator', 'RegexIterator', 'EmptyIterator', 'RecursiveArrayIterator', 'RecursiveIteratorIterator', 'MultipleIterator', 'ArrayIterator', 'ArrayObject', 'SplObjectStorage', 'SplObserver', 'SplSubject', 'OuterIterator', 'RecursiveIterator', 'SplDoublyLinkedList', 'SplQueue', 'SplStack', 'SplFixedArray', 'SplMinHeap', 'SplPriorityQueue'] as $c) {
    // __debugInfo is left out: the interpreter cannot show a native __debugInfo's private keys.
    echo $c, ': ', implode(',', class_implements($c)), ' | ', implode(',', array_diff(get_class_methods($c), ['__debugInfo'])), ' | ', implode(',', class_parents($c)), "\n";
}
