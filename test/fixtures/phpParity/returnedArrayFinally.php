<?php
function appendFinally() {
    $out = [];
    try { $out[] = "x"; return $out; }
    finally { $out[] = "fb"; }
}
function catchFinally() {
    $out = [];
    try { throw new Exception("x"); }
    catch (Throwable $error) { $out[] = "x"; return $out; }
    finally { $out[] = "fb"; }
}
function nestedFinally() {
    $out = [[]];
    try { $out[0][] = 1; return $out; }
    finally { $out[0][] = 2; }
}
var_dump(appendFinally(), catchFinally(), nestedFinally());
