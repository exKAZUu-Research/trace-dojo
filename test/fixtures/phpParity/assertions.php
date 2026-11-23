<?php
assert(1 + 1 === 2);
try { assert(1 > 2); } catch (AssertionError $e) { echo get_class($e), ": ", $e->getMessage(), "\n"; }
try { assert(false, "custom message"); } catch (AssertionError $e) { echo $e->getMessage(), "\n"; }
$x = 5; try { assert($x  <  3 && strlen("ab")>1); } catch (AssertionError $e) { echo $e->getMessage(), "\n"; }
try { assert(in_array("x", ["a" => 1], true) || $x->y ?? false); } catch (Throwable $e) { echo get_class($e), $e->getMessage(), "\n"; }
try { assert(!($x > 1) and -$x == [1, 2.5, null]); } catch (AssertionError $e) { echo $e->getMessage(), "\n"; }
try { assert(count([1]) === 2, new RuntimeException("custom exception")); } catch (RuntimeException $e) { echo $e->getMessage(), "\n"; }
