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
