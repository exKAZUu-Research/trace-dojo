<?php
class ValueGetter {
    public int $value = 1 { get { echo "get-value;"; return $this->value + 1; } }
}
$object = new ValueGetter();
try { $alias =& $object->value; $alias = 9; } catch (Throwable $error) { echo $error->getMessage(), "\n"; }
function mutate(&$value) { $value = 9; }
try { mutate($object->value); } catch (Throwable $error) { echo $error->getMessage(), "\n"; }
class ReferenceGetter {
    public int $value = 1 { &get { echo "get-reference;"; return $this->value; } }
}
$object = new ReferenceGetter();
$alias =& $object->value;
$alias = 9;
echo $object->value, "\n";
mutate($object->value);
echo $object->value, "\n";
