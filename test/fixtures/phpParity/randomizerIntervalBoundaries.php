<?php
use Random\Engine\Mt19937;
use Random\IntervalBoundary;
use Random\Randomizer;

$random = new Randomizer(new Mt19937(5));
var_dump($random->getFloat(1, 2));
foreach (IntervalBoundary::cases() as $boundary) {
    echo $boundary->name, "\n";
    var_dump($random->getFloat(1, 2, $boundary), $random->getFloat(-2, -1, $boundary));
}
var_dump(IntervalBoundary::ClosedOpen === IntervalBoundary::cases()[0]);
var_dump(enum_exists(IntervalBoundary::class), class_exists(IntervalBoundary::class),
    IntervalBoundary::OpenOpen instanceof UnitEnum);
var_dump(IntervalBoundary::OpenClosed);
echo var_export(IntervalBoundary::OpenClosed, true), "\n";
print_r(IntervalBoundary::OpenClosed);
var_dump(json_encode(IntervalBoundary::OpenClosed), json_last_error_msg());
foreach (IntervalBoundary::cases() as $boundary) {
    foreach ([[2, 2], [2, 1], [1, 1.0000000000000002], [-1.0000000000000002, -1]] as [$min, $max]) {
        try { var_dump($random->getFloat($min, $max, $boundary)); }
        catch (ValueError $error) { echo $error->getMessage(), "\n"; }
    }
}
try { $random->getFloat(1, 2, 'ClosedOpen'); }
catch (TypeError $error) { echo $error->getMessage(), "\n"; }
echo $random->nextInt(), "\n";
