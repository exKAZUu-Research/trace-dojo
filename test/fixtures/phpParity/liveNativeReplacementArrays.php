<?php
class ChangeText {
    function __construct(private string $result, private string|int $next) {}
    function __toString(): string {
        $GLOBALS['text'] = $this->next;
        return $this->result;
    }
}
$text = 'old';
var_dump(substr_replace(['abc', 'abc'], [new ChangeText('A', 'NEW'), &$text], 0, 3));
$text = 'old';
var_dump(substr_replace([new ChangeText('A', 'NEW'), &$text], ['x', 'y'], 0, 0));
$text = 1;
var_dump(substr_replace([new ChangeText('abc', 2)], ['X'], [&$text], [1]));
$text = 1;
var_dump(substr_replace(['abc'], [new ChangeText('X', 2)], [&$text], [&$text]));
$text = 'bogus';
var_dump(mb_detect_encoding('aaa', [new ChangeText('ASCII', 'UTF-8'), &$text]));
$text = 'bogus';
var_dump(mb_convert_encoding('abc', 'UTF-8', [new ChangeText('ASCII', 'UTF-8'), &$text]));
