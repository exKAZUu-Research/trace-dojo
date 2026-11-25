<?php
interface HasColor { const PREFIX = '#'; public function color(): string; }

enum Suit: string implements HasColor {
    case Hearts = 'H';
    case Spades = 'S';
    const Wild = self::Spades;

    public function color(): string {
        return self::PREFIX . match ($this) {
            Suit::Hearts => 'Red',
            Suit::Spades => 'Black',
        };
    }

    public static function fromChar(string $c): self { return static::from($c); }
}

enum Status { case Active; case Inactive; }

$h = Suit::Hearts;
var_dump($h, Suit::cases(), Status::cases());
print_r($h); echo "\n";
print_r(Status::Active); echo "\n";
var_export([Suit::Spades, 'k' => Status::Inactive]); echo "\n";
echo $h->name, $h->value, ' ', $h->color(), ' ', Suit::Wild->color(), "\n";
var_dump($h === Suit::from('H'), Suit::tryFrom('X'), Suit::fromChar('S'));
var_dump($h instanceof UnitEnum, $h instanceof BackedEnum, Status::Active instanceof BackedEnum, $h instanceof HasColor);
var_dump($h == Suit::Hearts, $h == Suit::Spades, $h < Suit::Spades, $h == 'H', $h == true);
echo get_class($h), ' ', $h::class, "\n";
var_dump(enum_exists('Suit'), enum_exists('Foo'), class_implements($h));
echo json_encode([$h, 'w' => Suit::Wild]), "\n";
var_dump(json_encode(Status::Active), json_last_error_msg());
var_dump(in_array(Suit::Hearts, [Suit::Spades, Suit::Hearts], true), array_search(Suit::Spades, Suit::cases()));
var_dump(array_column(Suit::cases(), 'value', 'name'));

foreach (['X', "it's"] as $value) {
    try {
        Suit::from($value);
    } catch (ValueError $e) {
        echo get_class($e), ': ', $e->getMessage(), "\n";
    }
}

enum Level: int { case Low = 1; case High = 1 + 2; }
var_dump(Level::from('3'), Level::tryFrom(2));
try { Level::from(7); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
try { Level::from('abc'); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }

$errors = [
    fn() => $h->name = 'x',
    fn() => $h->extra = 1,
    fn() => new Suit(),
    fn() => clone $h,
    fn() => (string) $h,
    fn() => [$h => 1],
    fn() => Status::from('Active'),
];
foreach ($errors as $error) {
    try {
        $error();
    } catch (Error $e) {
        echo get_class($e), ': ', $e->getMessage(), "\n";
    }
}

const DEFAULT_SUIT = Suit::Hearts->value;
function pick(Suit $suit = Suit::Spades): string { return $suit->name; }
echo DEFAULT_SUIT, ' ', pick(), ' ', pick(Suit::Hearts), "\n";

enum Dup: int { case A = 1; case B = 1; }
var_dump(count(Dup::cases()));
try { var_dump(Dup::A); } catch (Error $e) { echo $e->getMessage(), "\n"; }

try {
    echo match (Status::Inactive) { Status::Active => 'on' };
} catch (UnhandledMatchError $e) {
    echo $e->getMessage(), "\n";
}
