<?php
class ChangeValue {
    function __construct(private string $result, private string $newValue) {}
    function __toString(): string {
        $GLOBALS['value'] = $this->newValue;
        return $this->result;
    }
}
foreach (['array_udiff', 'array_uintersect'] as $name) {
    $value = 'old';
    $first = ['one', &$value, 'z'];
    $second = ['new', 'two'];
    $calls = 0;
    $compare = function ($a, $b) use (&$value, &$calls) {
        if (++$calls === 1) $value = 'new';
        return $a <=> $b;
    };
    var_dump($name($first, $second, $compare));
    unset($first, $compare);
}
$value = 'i';
var_dump(array_intersect(['b', 'i'], [new ChangeValue('a', 'b'), &$value]));
foreach ([SORT_NATURAL, SORT_REGULAR, SORT_LOCALE_STRING, SORT_NATURAL | SORT_FLAG_CASE] as $flag) {
    $value = 'i';
    var_dump(array_unique([new ChangeValue('a', 'b'), &$value, 'b'], $flag));
}
$value = 'c';
var_dump(min([new ChangeValue('z', 'a'), 'b', &$value]));
$value = 'a';
var_dump(max([&$value, new ChangeValue('b', 'z')]));
