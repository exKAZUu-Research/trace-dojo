<?php
class HiddenFailure extends Exception {
    function __toString(): string {
        echo "formatting the hidden fatal\n";
        return 'secret';
    }
}
error_reporting(E_WARNING);
echo "before\n";
throw new HiddenFailure('hidden');
