<?php
try { foreach (new LimitIterator(new ArrayIterator([1]), 4, 1) as $value) {} }
catch (Throwable $error) { echo $error->getTraceAsString(), "\n"; }
try { count(new CachingIterator(new ArrayIterator([1]))); }
catch (Throwable $error) { echo $error->getTraceAsString(), "\n"; }
try {
    foreach (new CallbackFilterIterator(new ArrayIterator([1]), function () {
        throw new Exception('filter');
    }) as $value) {}
} catch (Throwable $error) { echo $error->getTraceAsString(), "\n"; }
