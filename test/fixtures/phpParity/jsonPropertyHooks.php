<?php
class ParentHooks {
    public int $first = 1;
    public int $virtual { get { echo "virtual;"; return 2; } }
    protected int $hidden { get { echo "hidden;"; return 0; } }
}
class Hooks extends ParentHooks {
    public int $backed = 3 { get { echo "backed;"; return $this->backed + 1; } }
    public int $uninitialized { get { echo "uninitialized;"; return 5; } }
    public int $writeOnly { set {} }
    public int $last = 6;
}
$object = new Hooks();
echo json_encode($object), "\n";
try { unset($object->backed); }
catch (Throwable $error) { echo get_class($error), ": ", $error->getMessage(), "\n"; }
echo json_encode($object), "\n";
