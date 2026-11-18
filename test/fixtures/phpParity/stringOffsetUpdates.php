<?php
$subject = 'abc';
foreach (['missing', [], new stdClass(), '1.0', '10x', 0.5, null, true, 2, ' 2 '] as $offset) {
    try { $subject[$offset] += 1; }
    catch (Throwable $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
    try { $subject[$offset]++; }
    catch (Throwable $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
}
echo $subject, "\n";
