<?php
class StaticTarget {
    public static $number = 5;
    static function next() { return new self; }
    public $name = 'ready';
}
$absent = null;
$present = (object)['cls' => 'StaticTarget'];
var_dump($absent?->cls::next(), $absent?->cls::$number, $absent?->cls::next()->name);
var_dump($absent?->cls::next(...), isset($undefined?->cls::$number), $absent?->cls::$number ?? 'default');
var_dump($present?->cls::next()->name, $present?->cls::$number);
foreach ([1, "text", null, new stdClass] as $value) {
    try { [...$value]; } catch (Throwable $error) { echo get_class($error), ': ', $error->getMessage(), "\n"; }
}
var_dump([NAN . 'key' => NAN || true], [NAN || true => NAN . 'value']);

$recursive = [];
$recursive[] = &$recursive;
$mutable = [];
$recursive[] = &$mutable;
set_error_handler(function() use (&$mutable) { $mutable = [1, 2]; });
var_dump(count($recursive, COUNT_RECURSIVE));
restore_error_handler();

foreach (['a[a][b=v', 'a[a][b%00c]=v', 'a[b=v'] as $query) {
    parse_str($query, $parsed);
    echo json_encode($parsed), "\n";
}
