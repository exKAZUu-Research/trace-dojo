<?php
class BadStringifier extends Exception {
    function __toString(): string {
        echo "format warning\n";
        throw new ErrorException('formatter failed', 0, 1, 'warning.php', 42);
    }
}
class DebugInfoWarning {
    function __debugInfo() { throw new BadStringifier('debug failure'); }
}
var_dump(new DebugInfoWarning());
