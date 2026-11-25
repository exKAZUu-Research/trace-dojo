<?php
function g() { yield 1; throw new Exception('x'); }
try { foreach (g() as $v) {} } catch (Exception $e) { echo $e->getTraceAsString(), "\n"; }
$h = g(); $h->current();
try { $h->next(); } catch (Exception $e) { echo $e->getTraceAsString(), "\n"; }
function outer() { yield from g(); }
try { foreach (outer() as $v) {} } catch (Exception $e) { echo $e->getTraceAsString(), "\n"; }
function k() { throw new Exception('y'); yield; }
try { foreach (k() as $v) {} } catch (Exception $e) { echo $e->getTraceAsString(), "\n"; }
try { iterator_to_array(k()); } catch (Exception $e) { echo $e->getTraceAsString(), "\n"; }
