<?php
use Random\Randomizer;
use Random\Engine\Mt19937;
use Random\Engine\PcgOneseq128XslRr64;
use Random\Engine\Xoshiro256StarStar;
$r = new Randomizer(new Mt19937(42));
for ($i = 0; $i < 5; $i++) echo $r->getInt(1, 100), ' ';
echo "\n", $r->nextInt(), ' ', $r->getInt(PHP_INT_MIN, PHP_INT_MAX), ' ', $r->getInt(0, 2 ** 40), "\n";
var_dump($r->nextFloat(), $r->getFloat(0, 1), $r->getFloat(-5.5, 10), $r->getFloat(-100, 1));
echo bin2hex($r->getBytes(5)), ' ', bin2hex($r->getBytes(16)), "\n";
echo $r->getBytesFromString('abcdef', 10), ' ', $r->getBytesFromString('0123456789', 12), "\n";
print_r($r->shuffleArray(['a' => 1, 'b' => 2, 'c' => 3, 4, 5]));
echo $r->shuffleBytes('Hello World'), "\n";
print_r($r->pickArrayKeys(['a' => 1, 'b' => 2, 'c' => 3, 'd' => 4], 2));
print_r($r->pickArrayKeys([10, 20, 30, 40, 50], 4));
print_r($r->pickArrayKeys([10, 20, 30], 1));
$m = new Mt19937(1234);
echo bin2hex($m->generate()), ' ', bin2hex($m->generate()), "\n";
$p = new PcgOneseq128XslRr64(42);
$rp = new Randomizer($p);
for ($i = 0; $i < 5; $i++) echo $rp->getInt(1, 6), ' ';
echo "\n", bin2hex($p->generate()), ' ', $rp->nextInt(), "\n";
$p->jump(10);
echo bin2hex($p->generate()), "\n";
$p2 = new PcgOneseq128XslRr64('0123456789abcdef');
echo bin2hex($p2->generate()), "\n";
$x = new Xoshiro256StarStar(42);
$rx = new Randomizer($x);
for ($i = 0; $i < 5; $i++) echo $rx->getInt(1, 6), ' ';
echo "\n", bin2hex($x->generate()), "\n";
$x->jump(); echo bin2hex($x->generate()), "\n";
$x->jumpLong(); echo bin2hex($x->generate()), "\n";
$x2 = new Xoshiro256StarStar(str_repeat('ab', 16));
echo bin2hex($x2->generate()), ' ', $rx->nextFloat(), "\n";
echo implode(',', $rx->shuffleArray(range(1, 10))), "\n";
echo $rx->getFloat(1.5, 2.5), ' ', $rx->getFloat(-1e300, 1e300), "\n";
try { $r->getInt(5, 1); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
try { $r->getFloat(1, 1); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
try { $r->getFloat(INF, 1); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
try { $r->getBytes(0); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
try { $r->getBytesFromString('', 1); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
try { $r->getBytesFromString('a', 0); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
try { $r->pickArrayKeys([], 1); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
try { $r->pickArrayKeys([1, 2], 3); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
try { new Mt19937(1, 5); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
try { new PcgOneseq128XslRr64('short'); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
try { new Xoshiro256StarStar('short'); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
try { $p->jump(-1); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
$old = new Mt19937(7, MT_RAND_PHP);
$ro = new Randomizer($old);
echo $ro->getInt(1, 100), ' ', $ro->getInt(1, 100), ' ', $ro->nextInt(), "\n";
var_dump($r->engine === $r->engine, get_class($r->engine), $r->engine instanceof Random\Engine);
class MyEngine implements Random\Engine {
    private $n = 0;
    public function generate(): string { return chr($this->n++ % 256); }
}
$ru = new Randomizer(new MyEngine);
echo $ru->getInt(0, 1000), ' ', $ru->getInt(0, 3), ' ', bin2hex($ru->getBytes(3)), ' ', $ru->nextInt(), "\n";
class EmptyEngine implements Random\Engine { public function generate(): string { return ''; } }
try { (new Randomizer(new EmptyEngine))->getInt(1, 10); } catch (Random\BrokenRandomEngineError $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
print_r(class_parents('Random\BrokenRandomEngineError'));
print_r(class_parents('Random\RandomException'));
print_r(class_implements('Random\Engine\Mt19937'));
print_r(class_implements('Random\Engine\Secure'));
print_r(get_class_methods('Random\Randomizer'));
$c = clone $p;
echo bin2hex($c->generate()), ' ', bin2hex($p->generate()), "\n";
