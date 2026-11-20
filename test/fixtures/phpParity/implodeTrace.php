<?php
class StringFailure {
    function __toString(): string { throw new Exception('string'); }
}
foreach ([fn() => implode('abc'), fn() => implode([1], [2]), fn() => implode([new StringFailure])] as $try) {
    try { $try(); } catch (Throwable $error) { echo $error->getMessage(), "\n", $error->getTraceAsString(), "\n"; }
}
