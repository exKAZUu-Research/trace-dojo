<?php
var_dump(@mb_check_encoding(), mb_strstr("a\x80b", "b"), @mb_check_encoding(), mb_convert_kana("\x80"), @mb_check_encoding(), mb_scrub("\x80"), @mb_check_encoding());
