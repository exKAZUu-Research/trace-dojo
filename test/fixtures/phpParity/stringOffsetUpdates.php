<?php
$subject = 'abc';
foreach (['missing', [], new stdClass(), '1.0', '10x', 0.5, null, true, 2, ' 2 '] as $offset) {
    try { $subject[$offset] += 1; }
    catch (Throwable $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
    try { $subject[$offset]++; }
    catch (Throwable $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
}
echo $subject, "\n";

foreach ([NAN, INF, -INF, 1e30, -1e30, 1.5] as $offset) {
    var_dump($subject[$offset], $subject[$offset] ?? 'default', isset($subject[$offset]), empty($subject[$offset]));
}
$subject[NAN] = 'X';
$subject[INF] = 'Y';
$subject[-1e30] = 'Z';
echo $subject, "\n";

class ReplacingCharacter {
    function __toString(): string {
        $GLOBALS['subject'] = 'replacement';
        return 'X';
    }
}
$subject = 'abc';
$result = ($subject[1] = new ReplacingCharacter);
var_dump($result, $subject);

$subject = 'abc';
set_error_handler(function () { $GLOBALS['subject'] = 'abc'; return true; });
$result = ($subject[1] = 'XY');
restore_error_handler();
var_dump($result, $subject);
