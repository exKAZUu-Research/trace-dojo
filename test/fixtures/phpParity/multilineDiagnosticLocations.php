<?php
set_error_handler(function($errno,$message,$file,$line) { echo "$line $message\n"; return true; });
try { Missing
    ::
    CONST; } catch (Throwable $e) {echo $e->getLine(), " ",$e->getMessage(),"\n";}
try { Missing
    ::
    $prop; } catch (Throwable $e) {echo $e->getLine(), " ",$e->getMessage(),"\n";}
$number=1;
foreach (
    $number
    as $unused) {}
$undef
    +
    1;
try { match (1) {
    0 =>
        2,
    3 =>
        4,
}; } catch (Throwable $e) {echo $e->getLine(), " ",$e->getMessage(),"\n";}
$f = 1;
try { $f
    (
      1
    ); } catch (Throwable $e) {echo $e->getLine(), " ",$e->getMessage(),"\n";}
try { strlen(
    []
); } catch (Throwable $e) {echo $e->getLine(), " ",$e->getMessage(),"\n";}
try { strlen(
    1+[]
); } catch (Throwable $e) {echo $e->getLine(), " ",$e->getMessage(),"\n";}
try { match (1) {
    0 =>
         2,
}; } catch (Throwable $e) {echo $e->getLine(), " ",$e->getMessage(),"\n";}
try { match (1) {
    0 + rand(0,0) =>
        2,
    3 =>
        4,
}; } catch (Throwable $e) {echo $e->getLine(), " ",$e->getMessage(),"\n";}
$u = function(int $x) {};
try { $u
    (
      'x'
    ); } catch (Throwable $e) {echo $e->getMessage(),"\n";}
$u = 'absent';
try { $u
    (1); } catch (Throwable $e) {echo $e->getLine(), " ",$e->getMessage(),"\n";}
try { substr(
    [],
    1
); } catch (Throwable $e) {echo $e->getLine(), " ",$e->getMessage(),"\n";}
$x=match(0) {0=>1};
try { match (1) {
    0,
    2 =>
        2,
}; } catch (Throwable $e) {echo $e->getLine(),"\n";}
try { match (1) {
}; } catch (Throwable $e) {echo $e->getLine(),"\n";}
try { strlen('a'+
    'b'
); } catch (Throwable $e) {echo $e->getLine(),"\n";}
function noValue(): int {
    echo "no return\n";
}
try { noValue(); } catch (Throwable $e) { echo $e->getLine(), " ", $e->getMessage(), "\n"; }
