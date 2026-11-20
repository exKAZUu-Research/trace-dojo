<?php
foreach (["preg_match", "preg_match_all"] as $fn) {
    $matches = "old";
    try { $fn('/a/', 'aa', $matches, 9999); } catch (Throwable $error) { echo $error->getMessage(), "\n"; }
    var_dump($matches);
    $matches = "old";
    var_dump($fn('/[/', 'aa', $matches, 9999), $matches);
}
try { preg_match('/a/', 'aa', $matches, PREG_SET_ORDER); }
catch (Throwable $error) { echo $error, "\n"; }
