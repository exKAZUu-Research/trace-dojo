<?php
function emptyExtremes($values) {
    try { min($values); }
    catch (ValueError $error) { echo $error->getMessage(), "\n", $error->getTraceAsString(), "\n"; }
    try { max($values); }
    catch (ValueError $error) { echo $error->getMessage(), "\n", $error->getTraceAsString(), "\n"; }
}
emptyExtremes([]);
try { min('invalid'); }
catch (TypeError $error) { echo $error->getMessage(), "\n", $error->getTraceAsString(), "\n"; }
