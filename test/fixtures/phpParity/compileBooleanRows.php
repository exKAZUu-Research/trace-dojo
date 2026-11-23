<?php
function className() { echo 'unreachable'; return 'stdClass'; }
echo 'begin;';
var_dump((NAN xor true) instanceof(className()));
var_dump((false xor NAN) instanceof(className()));
var_dump((NAN xor
NAN) instanceof(className()));
var_dump(true &&
    NAN);
var_dump(false ||
    NAN);
var_dump((
    NAN
) || className());
var_dump(('x' . (1.5 + 1)) instanceof(className()));
var_dump(('x' . INF) instanceof(className()));
var_dump(('x' . NAN) instanceof(className()));
