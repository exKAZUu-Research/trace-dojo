<?php
class BadDebugInfo { public function __debugInfo() { return 123; } }
function dump_object($object) { var_dump($object); }
dump_object(new BadDebugInfo());
