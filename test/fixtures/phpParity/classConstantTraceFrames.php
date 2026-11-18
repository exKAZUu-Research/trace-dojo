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
