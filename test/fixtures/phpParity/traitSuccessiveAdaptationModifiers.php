<?php
trait Role { public function run() { echo 'trait'; } }
class ProtectedLatest { use Role { run as final; run as protected; } }
class PrivateLatest { use Role { run as final; run as private; } }
class OverrideProtected extends ProtectedLatest { public function run() { echo 'protected'; } }
class OverridePrivate extends PrivateLatest { public function run() { echo 'private'; } }
(new OverrideProtected)->run();
(new OverridePrivate)->run();
class FinalLatest { use Role { run as private; run as final; } }
class OverrideFinal extends FinalLatest { public function run() {} }
