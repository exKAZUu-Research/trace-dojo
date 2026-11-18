<?php
$fixed = SplFixedArray::fromArray(['zero']);
foreach (['0', '9223372036854775807', '-9223372036854775808', '9223372036854775808', '-9223372036854775809', '01', '-0'] as $key) {
    echo $key, "\n";
    try { var_dump(isset($fixed[$key])); }
    catch (Throwable $error) { echo get_class($error), "\n"; }
    try { var_dump($fixed[$key]); }
    catch (Throwable $error) { echo get_class($error), "\n"; }
    try { $fixed[$key] = 'updated'; }
    catch (Throwable $error) { echo get_class($error), "\n"; }
}
