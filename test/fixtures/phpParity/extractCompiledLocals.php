<?php
function extractLocals($flags) {
    $initialized = null;
    $unset = 1;
    unset($unset);
    try {} catch (Exception $caught) {}
    $source = ['unset' => 11, 'initialized' => 12, 'caught' => 13, 'absent' => 14];
    var_dump(extract($source, EXTR_PREFIX_IF_EXISTS | $flags, 'p'));
    var_dump($unset, $p_initialized, $caught);
    $unset = 21;
    $p_initialized = 22;
    var_dump($source);
}
extractLocals(0);
extractLocals(EXTR_REFS);
var_dump(extract(['main' => 42], EXTR_PREFIX_IF_EXISTS, 'p'), $main);

function extractOrder($parameter, $flags) {
    $dynamicName = 'dynamic';
    $$dynamicName = 'value';
    $count = extract(['param' => -1, 'parameter' => 10, 'x' => 42], EXTR_PREFIX_IF_EXISTS | $flags, 'p');
    $first = 1;
    var_dump(array_keys(get_defined_vars()), $x);
    unset($parameter);
    $count += extract(['parameter' => 3], EXTR_PREFIX_IF_EXISTS | $flags, 'p');
    var_dump(array_keys(get_defined_vars()), $parameter, $count);
}
extractOrder(0, 0);
extractOrder(0, EXTR_REFS);

function compiledTraversalOrder() {
    if (false) {
        [$left, $right] = $source;
        for ($start = $init; $condition; $update = $step) $body;
        while ($check) $inside;
    }
    $table = ['key' => 7];
    foreach ($table as $key => $item) {}
    extract(array_fill_keys(['left', 'right', 'source', 'start', 'init', 'condition', 'update', 'step', 'body', 'check', 'inside'], 1));
    echo implode(',', array_keys(get_defined_vars())), "\n";
}
compiledTraversalOrder();

class LocalLifetime {
    function __construct(public $label) {}
    function __destruct() { echo $this->label; }
}
function releaseInSlotOrder() {
    $one = isset($two) ? null : new LocalLifetime('one');
    $three = new LocalLifetime('three');
    $two = new LocalLifetime('two');
}
releaseInSlotOrder();
echo "\n";
(function () {
    $head = isset($tail);
    $middle = 2;
    $tail = 3;
    foreach (get_defined_vars() as $key => $value)
        if (in_array($key, ['head', 'middle', 'tail'], true)) echo $key, "\n";
})();
