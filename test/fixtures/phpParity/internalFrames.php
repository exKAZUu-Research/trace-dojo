<?php
function g() { return array_keys(1); }
try { g(); } catch (TypeError $e) { echo $e->getTraceAsString(), "\n"; }
try { abs('x'); } catch (TypeError $e) { echo $e->getTraceAsString(), "\n"; }
try { str_repeat("a", -1); } catch (ValueError $e) { echo $e->getTraceAsString(), "\n"; }
class A { function __toString(): string { throw new Exception("ts"); } }
try { echo new A; } catch (Exception $e) { echo $e->getTraceAsString(), "\n"; }
try { $s = "x" . new A; } catch (Exception $e) { echo $e->getTraceAsString(), "\n"; }
try { strlen(new A); } catch (Exception $e) { echo $e->getTraceAsString(), "\n"; }
try { array_map(fn($x) => throw new Exception("cb"), [1]); } catch (Exception $e) { echo $e->getTraceAsString(), "\n"; }
try { usort($u, 'nope'); } catch (TypeError $e) { echo $e->getMessage(), "\n", $e->getTraceAsString(), "\n"; }
try { intdiv(1, 0); } catch (DivisionByZeroError $e) { echo $e->getTraceAsString(), "\n"; }
function h(string ...$xs) {} try { h("a", []); } catch (TypeError $e) { echo $e->getTraceAsString(), "\n"; }
