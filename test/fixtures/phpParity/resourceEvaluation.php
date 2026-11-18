<?php
foreach ([STDIN, STDOUT, STDERR, 2, 1.999, '2', '2x', 'abc', '', null, true, false, [], [1], new stdClass] as $value)
    echo gettype($value), ':', STDOUT <=> $value, ',', $value <=> STDOUT, ';', STDOUT == $value ? 'true' : 'false', "\n";
var_dump((object)STDOUT, (array)STDOUT);
var_dump(var_export(STDOUT, true), var_export([STDERR], true));
$stream = STDOUT;
foreach ([
    fn() => $stream::class,
    fn() => $stream::VALUE,
    fn() => $stream::method(),
    fn() => $stream instanceof $stream,
    fn() => new $stream,
] as $run) try { var_dump($run()); } catch (Throwable $error) { echo $error->getMessage(), "\n"; }
function printStreamTrace($stream) {
    echo (new Exception)->getTraceAsString(), "\n";
    debug_print_backtrace();
}
printStreamTrace(STDOUT);
