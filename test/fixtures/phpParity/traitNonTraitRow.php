<?php
class Used {}
try {
    if (true) {
        class UserOfNonTrait {
            use Used;
        }
    }
} catch (Throwable $error) {
    echo $error->getMessage(), "\n", $error->getLine(), "\n";
}
