<?php
class MissingConstant {
    const VALUE = self::NONE;
}
try { echo MissingConstant::VALUE; }
catch (Error $error) { echo $error->getLine(), "\n", $error->getTraceAsString(), "\n"; }
class MissingDefault {
    public $value = [1, self::NONE];
}
try { new MissingDefault; }
catch (Error $error) { echo $error->getTraceAsString(), "\n"; }
class MissingStatic {
    public static $value = self::NONE;
}
try { echo MissingStatic::$value; }
catch (Error $error) { echo $error->getTraceAsString(), "\n"; }
try { class SameLine { const VALUE = self::NONE; } echo SameLine::VALUE; }
catch (Error $error) { echo $error->getTraceAsString(), "\n"; }
try { echo UNKNOWN_VALUE; }
catch (Error $error) { echo $error->getTraceAsString(), "\n"; }

class PlainConstants {
    const VALUE = UNKNOWN_VALUE;
    public $value = UNKNOWN_VALUE;
}
class PlainStatic {
    public static $value = UNKNOWN_VALUE;
}
class NestedConstants {
    const DIVIDE = ConstantLeaves::DIVIDE;
    const MISSING = ConstantLeaves::MISSING;
}
class ConstantLeaves {
    const DIVIDE = 1 / 0;
    const MISSING = UNKNOWN_VALUE;
}
foreach ([
    fn () => PlainConstants::VALUE,
    fn () => new PlainConstants,
    fn () => PlainStatic::$value,
    fn () => NestedConstants::DIVIDE,
    fn () => NestedConstants::MISSING,
] as $read) {
    try { $read(); }
    catch (Error $error) { echo $error->getLine(), "\n", $error->getTraceAsString(), "\n"; }
}
