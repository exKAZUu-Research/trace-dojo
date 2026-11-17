<?php
function t($f) { try { $f(); } catch (Throwable $e) { echo explode("\n", $e->getTraceAsString())[0], "\n"; } }
t(fn() => strlen([]));
t(fn() => count(1));
t(fn() => sizeof(1));
t(fn() => array_key_exists([], []));
t(fn() => in_array(1, 5));
t(fn() => chr([]));
t(fn() => ord([]));
t(fn() => intval([], []));
t(fn() => strval([]));
t(fn() => get_class(1));
t(fn() => gettype());
t(fn() => boolval());
t(fn() => sprintf("%d"));
t(fn() => array_slice(1, 1));
t(fn() => defined([]));
t(fn() => floatval([]));
t(fn() => str_repeat([], 1));
