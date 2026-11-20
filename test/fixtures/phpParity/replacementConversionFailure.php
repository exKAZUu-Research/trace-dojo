<?php
class Substitute {
    function __construct(public string $name) {}
    function __toString() { echo "convert $this->name\n"; throw new Exception($this->name); }
}
foreach (['str_replace', 'str_ireplace'] as $replace) {
    foreach ([
        [['A', 'b'], [new Substitute('replacement'), 'x'], ['AAAb', 'b']],
        [['x', 'b'], [new Substitute('no match'), new Substitute('skipped')], 'Abc'],
        [[new Substitute('search'), 'A'], [new Substitute('skipped'), 'y'], 'AAA'],
        [['A', 'b'], [new Substitute('empties subject'), new Substitute('skipped')], 'AAA'],
        [['A'], [new Substitute('empty subject')], ''],
    ] as [$search, $replacement, $subject]) {
        $count = -1;
        try { $replace($search, $replacement, $subject, $count); }
        catch (Exception $e) { echo $e->getMessage(), "\n"; }
        echo "$count\n";
    }
}
