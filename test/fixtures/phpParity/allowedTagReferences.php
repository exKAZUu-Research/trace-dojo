<?php
class TagName {
    public function __toString(): string {
        $GLOBALS['tag'] = 'b';
        return 'a';
    }
}
$html = '<a>A</a><b>B</b><i>I</i>';
$tag = 'i';
var_dump(strip_tags($html, [new TagName, &$tag]));
$tag = 'i';
set_error_handler(function () use (&$tag) { $tag = 'b'; });
var_dump(strip_tags($html, [[], &$tag]));
restore_error_handler();
