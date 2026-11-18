<?php
interface CustomThrowable extends Throwable {}
class AllowedThrowable extends Exception implements CustomThrowable {}
echo "before\n";
class DirectThrowable implements CustomThrowable {}
echo "never\n";
