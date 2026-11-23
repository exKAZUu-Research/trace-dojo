<?php
class FirstFormattingError extends Exception {
    function __toString(): string {
        echo "first format\n";
        throw new SecondFormattingError('replacement');
    }
}
class SecondFormattingError extends Exception {
    function __toString(): string {
        echo "second format\n";
        throw new ErrorException('final error', 0, 1, 'formatted.php', 23);
    }
}
throw new FirstFormattingError('original');
