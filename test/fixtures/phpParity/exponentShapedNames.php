<?php
function e2() { return 1; }
function E10() { return 3; }
const E1 = 2;
var_dump(1 + e2(), E10(), E1);
try { var_dump(e5 ?? 'none'); } catch (Throwable $error) { echo $error->getMessage(), "\n"; }
