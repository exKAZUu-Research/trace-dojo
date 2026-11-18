<?php
class ExitOnConversion {
    function __toString(): string { echo 'cast;'; exit; }
}
vprintf('before[%s]after', [new ExitOnConversion]);
echo 'never';
