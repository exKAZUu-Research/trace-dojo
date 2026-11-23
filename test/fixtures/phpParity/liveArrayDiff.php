<?php
class UpdatesReference {
    function __toString(): string {
        $GLOBALS['value'] = 'b';
        return 'a';
    }
}
$value = 'i';
var_export(array_diff(['b','i'], [new UpdatesReference, &$value]));
echo "\n";
$value = 'i';
var_export(array_diff(['b'], [new UpdatesReference, &$value]));
echo "\n";
