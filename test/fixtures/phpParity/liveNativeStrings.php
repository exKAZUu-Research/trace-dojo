<?php
class ChangesArgument {
    function __toString() {
        global $value, $width;
        $value = 'new';
        $width = 5;
        return 'first';
    }
}
$value = 'old';
$members = [new ChangesArgument, &$value];
var_dump(implode(',', $members));
$value = 'old';
var_dump(join($members));
$value = 'old';
var_dump(vsprintf('%s,%s', $members));
$value = 'old';
vprintf("%s,%s\n", $members);
$value = 'old';
vfprintf(STDOUT, "%s,%s\n", $members);
$value = 'old';
$width = 3;
var_dump(vsprintf('%s,%*s', [new ChangesArgument, &$width, &$value]));
$value = 'old';
$format = '%s,%s';
var_dump(sprintf($format, new ChangesArgument, $value));

class SprintfChangingValue {
    function __toString(): string {
        echo 'convert;';
        $GLOBALS['part'] = 'new';
        return 'first';
    }
}
function sprintfOperand(): string {
    echo 'operand;';
    return 'last';
}
$part = 'old';
echo sprintf('%s,%%%s,%s', new SprintfChangingValue, $part, sprintfOperand()), "\n";
$part = 'old';
$pattern = '%s,%%%s,%s';
echo sprintf($pattern, new SprintfChangingValue, $part, sprintfOperand()), "\n";
