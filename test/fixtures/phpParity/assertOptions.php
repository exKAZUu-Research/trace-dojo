<?php
var_dump(ASSERT_ACTIVE, ASSERT_CALLBACK, ASSERT_BAIL, ASSERT_WARNING, ASSERT_EXCEPTION);
var_dump(assert_options(ASSERT_ACTIVE));
var_dump(assert_options(ASSERT_WARNING));
var_dump(assert_options(ASSERT_BAIL));
var_dump(assert_options(ASSERT_CALLBACK));
var_dump(assert_options(ASSERT_EXCEPTION));
var_dump(assert_options(ASSERT_ACTIVE, 0));
var_dump(assert_options(ASSERT_ACTIVE));
var_dump(assert_options(ASSERT_CALLBACK, 'strlen'));
var_dump(assert_options(ASSERT_CALLBACK));
var_dump(assert_options(ASSERT_WARNING, true));
try { var_dump(assert_options(99)); } catch (Throwable $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
try { var_dump(assert_options(99, 1)); } catch (Throwable $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
var_dump(assert(false));
echo "end\n";
