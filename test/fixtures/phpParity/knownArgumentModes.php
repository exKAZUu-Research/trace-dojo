<?php
function writeValue(&$value){$value=1;}
$a=[];writeValue($a[]);writeValue(value:$a[]);var_dump($a);
$dynamic='strlen';echo 'before;';try{$dynamic($a[]);}catch(Throwable $e){echo $e->getMessage(),"\n";}
class ByReferenceArgument {static function write(&$value){$value=2;}}
ByReferenceArgument::write($a[]);var_dump($a);

class TemporaryArgument { public $value = 'temporary'; }
laterReferenceArgument((new TemporaryArgument())->value);
LaterReferenceMethod::write((new TemporaryArgument())->value);
function laterReferenceArgument(&$value) { echo $value, "\n"; }
class LaterReferenceMethod {
    static function write(&$value) { echo $value, "\n"; }
}
