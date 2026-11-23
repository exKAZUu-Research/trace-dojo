<?php
try { strlen('a', 'b'); } catch(Throwable $e) { echo $e, "\n"; }
try { count(5, 1); } catch(Throwable $e) { echo $e, "\n"; }
try { strlen(string: []); } catch(Throwable $e) { echo $e, "\n"; }
try { strval(new stdClass); } catch(Throwable $e) { echo $e, "\n"; }
try { sprintf('%s-%d', new stdClass, 1); } catch(Throwable $e) { echo $e, "\n"; }
