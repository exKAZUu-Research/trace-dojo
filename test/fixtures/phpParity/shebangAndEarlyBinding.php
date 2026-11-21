#!/usr/bin/env php <?php this is skipped
<?php
declare(strict_types=1);
var_dump(__LINE__, class_exists('WithMagic', false));
class WithMagic {
    private function __toString() {}
}
echo 'never';
