<?php
function typed(
    string $first,
    int $second,
    int ...$rest
) {}
try { typed('valid'); }
catch (Throwable $error) { echo $error->getLine(), ':', $error->getMessage(), "\n"; }
try { typed('valid', []); }
catch (Throwable $error) { echo $error->getLine(), ':', $error->getMessage(), "\n"; }
try { typed('valid', 1, []); }
catch (Throwable $error) { echo $error->getLine(), ':', $error->getMessage(), "\n"; }
function withDefault(
    $value =
        MISSING_DEFAULT
) {}
try { withDefault(); }
catch (Throwable $error) { echo $error->getLine(), ':', $error->getMessage(), "\n"; }
class Promoted {
    function __construct(
        private int $first,
        private string $second
    ) {}
}
try { new Promoted(1); }
catch (Throwable $error) { echo $error->getLine(), ':', $error->getMessage(), "\n"; }
