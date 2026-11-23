<?php
try { try { throw new Exception("first"); } finally { throw new Exception("second"); } }
catch (Exception $e) { echo $e->getMessage(), " <- ", $e->getPrevious()?->getMessage(), "\n"; }
try { try { throw new Exception("a"); } finally { throw new Exception("b", 0, new Exception("c")); } }
catch (Exception $e) { for ($x = $e; $x; $x = $x->getPrevious()) echo $x->getMessage(), " "; echo "\n"; }
function f() { try { throw new Exception("in"); } finally { return 1; } }
var_dump(f());
try { try { throw new LogicException("l"); } catch (LogicException $e) { throw new RuntimeException("r"); } finally { throw new Exception("f"); } }
catch (Exception $e) { for ($x = $e; $x; $x = $x->getPrevious()) echo get_class($x), " "; echo "\n"; }
try { throw new Exception("x"); } finally { throw new Error("y"); }
