<?php
foreach ([fn() => sprintf(format: "%s", values: 1), fn() => array_merge(x: [1]), fn() => max(a: 1, b: 2), fn() => printf("%s", v: 1), fn() => call_user_func("strlen", string: "ab"), fn() => compact(a: "x"), fn() => array_push($arr, v: 1)] as $f) { try { var_dump($f()); } catch (Error $e) { echo get_class($e), ": ", $e->getMessage(), "\n"; } }
