<?php
class MyException extends Exception {
    public function __construct(string $message, private string $extra = "x") { parent::__construct($message, 42); }
    public function getExtra(): string { return $this->extra; }
}
function risky(int $n) { if ($n > 2) throw new MyException("too big: $n", "info"); return $n; }
try { echo risky(1), "\n"; echo risky(5), "\n"; } catch (MyException $e) { echo get_class($e), " ", $e->getMessage(), " ", $e->getCode(), " ", $e->getExtra(), " line ", $e->getLine(), "\n"; } finally { echo "finally\n"; }
function f() { try { return "try"; } finally { echo "in finally\n"; } }
echo f(), "\n";
function g() { try { throw new Exception("a"); } catch (Exception $e) { return "caught " . $e->getMessage(); } finally { echo "g-finally\n"; } }
echo g(), "\n";
try { try { throw new RuntimeException("inner"); } finally { echo "inner finally\n"; } } catch (Exception $e) { echo "outer caught ", $e->getMessage(), "\n"; }
try { throw new InvalidArgumentException("bad arg"); } catch (RuntimeException | InvalidArgumentException $e) { echo "multi ", get_class($e), "\n"; }
try { intdiv(1, 0); } catch (DivisionByZeroError $e) { echo $e->getMessage(), "\n"; }
try { echo 1 % 0; } catch (DivisionByZeroError $e) { echo $e->getMessage(), "\n"; }
try { echo 1 / 0; } catch (DivisionByZeroError $e) { echo $e->getMessage(), "\n"; }
try { $nn = null; $nn->method(); } catch (Error $e) { echo $e->getMessage(), "\n"; }
try { throw new Exception("with prev", 1, new LogicException("cause")); } catch (Exception $e) { echo $e->getPrevious()->getMessage(), "\n"; }
$e = new Exception("msg"); echo $e->getLine(), " ", $e->getFile() === __FILE__ ? "same" : "other", "\n";
function thrower() { throw new DomainException("deep"); }
function middle() { thrower(); }
try { middle(); } catch (Exception $e) { echo $e->getTraceAsString(), "\n"; print_r(array_map(fn($f) => $f['function'], $e->getTrace())); }
try { throw new ErrorException("ee", 1, E_WARNING); } catch (ErrorException $e) { echo $e->getSeverity(), "\n"; }
set_error_handler(function($no, $str, $file, $line) { echo "handler: [$no] $str at $line\n"; return true; });
echo $undefinedVar;
$arr = []; echo $arr['missing'];
restore_error_handler();
$x = @$arr['quiet'];
echo "end\n";
throw new MyException("uncaught!");
