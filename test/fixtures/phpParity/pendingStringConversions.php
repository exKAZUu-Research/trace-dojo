<?php
class ThrowOnString {
    function __toString(): string { throw new Exception('string conversion'); }
}
function translateEmptyKey(): void {
    strtr('a', ['' => new ThrowOnString]);
}
function check($operation): void {
    error_clear_last();
    try { $operation(); }
    catch (Throwable $error) { echo 'caught: ', $error->getMessage(), "\n"; }
    echo error_get_last()['message'] ?? 'no last error', "\n";
}
foreach ([null, E_NOTICE, E_WARNING] as $mask) {
    if ($mask !== null) set_error_handler(function () {
        echo "handler\n";
        throw new Exception('warning conversion');
    }, $mask);
    check(fn() => printf("%s|%s|%d|%f\n", new ThrowOnString, [], new stdClass, new stdClass));
    check(fn() => printf("%s|%s|%s\n", [], [], NAN));
    $count = -1;
    check(function () use (&$count) {
        str_replace([new ThrowOnString, [], 'x'], ['', '', 'y'], 'x Array', $count);
    });
    echo 'replacements: ', $count, "\n";
    check('translateEmptyKey');
    if ($mask !== null) restore_error_handler();
}
try { strtr('x', ['' => new stdClass]); }
catch (Throwable $error) { echo $error->getMessage(), "\n"; }
strtr('x', ['' => '']);
