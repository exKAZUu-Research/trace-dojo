<?php
class WrappedIterator extends ArrayIterator {
    public function rewind(): void {
        foreach (debug_backtrace() as $record) {
            echo $record['function'], ':', $record['class'] ?? '-', ':';
            echo isset($record['object']) ? get_class($record['object']) : '-';
            echo "\n";
        }
    }
}
$iterator = new IteratorIterator(new WrappedIterator([1]));
$iterator->rewind();

class ThrowingString {
    public function __toString(): string {
        $GLOBALS['reference'] = 'changed';
        throw new Exception('stop');
    }
}
$reference = 'original';
$arguments = ['%s %s', &$reference, new ThrowingString];
try { call_user_func_array('sprintf', $arguments); } catch (Throwable $e) {
    foreach ($e->getTrace() as $frame) {
        if ($frame['function'] === 'sprintf') var_dump($frame['args'][1]);
    }
}
function variadicFailure(...$args) { throw new Exception('variadic'); }
try { call_user_func(callback: 'variadicFailure', extra: 'value'); } catch (Throwable $e) {
    echo $e->getTraceAsString(), "\n";
}
