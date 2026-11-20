<?php
class TypedReferences {
    public float $floating = 1;
    public int $integer = 2;
    public bool $boolean = true;
    public int|string $either = '5';
    public static int $static = 4;
}
function wantsInt(int &$value) { var_dump($value); }
function wantsFloat(float &$value) { var_dump($value); }
function wantsString(string &$value) { var_dump($value); }
$data = new TypedReferences;
foreach ([
    fn () => wantsInt($data->floating),
    fn () => wantsFloat($data->integer),
    fn () => wantsString($data->boolean),
    fn () => wantsFloat(TypedReferences::$static),
    fn () => wantsInt($data->either),
] as $check) {
    try { $check(); }
    catch (TypeError $error) { echo $error->getMessage(), "\n"; }
}
var_dump($data->floating, $data->integer, $data->boolean, $data->either, TypedReferences::$static);
