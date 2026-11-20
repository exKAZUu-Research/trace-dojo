<?php
class Typed {
    public int $i = 7;
    public ?int $nullable = 7;
    public float $f = 7;
    public string $s = '7';
    public mixed $m = 7;
    public int|float $union = 7;
    public $untyped = 7;
    public static int $static = 7;
}
function report(Throwable $error) {
    echo get_class($error), ': ', $error->getMessage(), ' / ', $error->getPrevious()?->getMessage() ?? '-', "\n";
}
foreach (['i', 'nullable', 'f', 's', 'm', 'union', 'untyped'] as $field) {
    $object = new Typed;
    try { $object->$field /= 0; } catch (Throwable $error) { report($error); }
    var_dump($object->$field);
}
$object = new Typed;
$ref = &$object->s;
try { $ref /= 0; } catch (Throwable $error) { report($error); }
var_dump($ref);
try { $ref .= new stdClass; } catch (Throwable $error) { report($error); }
var_dump($ref);
try { $object->s /= 0; } catch (Throwable $error) { report($error); }
var_dump($ref);
try { Typed::$static -= []; } catch (Throwable $error) { report($error); }
var_dump(Typed::$static);
