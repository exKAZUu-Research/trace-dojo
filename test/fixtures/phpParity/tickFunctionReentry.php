<?php
declare(ticks=1);
function t($x) { echo "T$x\n"; }
register_tick_function('t', 'a');
register_tick_function('t', 'b');
$a = 1;
