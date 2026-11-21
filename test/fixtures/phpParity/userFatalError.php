<?php
function f() { trigger_error("fatal!", E_USER_ERROR); }
echo "a\n";
f();
echo "b\n";
