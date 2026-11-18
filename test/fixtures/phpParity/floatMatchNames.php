<?php
foreach ([1.0, -0.0, 1e14, 1e15, 1e-5, 0.0001, 12345678901234.5, 0.1+0.2, 0.5, INF, -INF, NAN] as $value) {
    try { match ($value) {}; } catch (UnhandledMatchError $error) { echo $error->getMessage(), "\n"; }
}
