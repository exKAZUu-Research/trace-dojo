<?php
class TracedArgument {
    function __construct(public int $id) {}
    function __destruct() { echo "drop argument $this->id\n"; }
}
class CaughtError extends Exception {
    function __destruct() { echo "drop error\n"; }
}
function fail_with($value) { throw new CaughtError(); }
try {
    fail_with(new TracedArgument(1));
} catch (CaughtError $error) {
    echo "bound\n";
    unset($error);
    echo "unbound\n";
}
try {
    fail_with(new TracedArgument(2));
} catch (CaughtError) {
    echo "unbound catch\n";
} finally {
    echo "finally\n";
}
