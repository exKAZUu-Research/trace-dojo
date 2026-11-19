<?php
class ArraySettings extends ArrayObject {
    public $theme = null;
    public int $count;
    protected $privateLabel = 'own';

    public function label() {
        return $this->privateLabel;
    }
}
$settings = new ArraySettings([
    'theme' => 'shadow', 'count' => 2, 'privateLabel' => 'backing', 'options' => ['compact'],
    'empty' => null, 0 => 'first'
], ArrayObject::ARRAY_AS_PROPS);
var_dump($settings->theme, $settings->count, $settings->privateLabel, $settings->label(), $settings->{'0'});
var_dump(isset($settings->theme), isset($settings->count), empty($settings->empty), property_exists($settings, 'empty'));
var_dump($settings->unknown ?? 'default');
unset($settings->theme);
$settings->theme = 'light';
$settings->count += 3;
$settings->options[] = 'wide';
$alias =& $settings->count;
++$settings->count;
$settings->other =& $alias;
$alias = 7;
unset($settings->empty);
var_dump($settings->getArrayCopy());

$iterator = $settings->getIterator();
var_dump($iterator->theme);
$iterator->setFlags(0);
var_dump(isset($iterator->theme), $iterator->getArrayCopy()['theme']);
$iterator->setFlags(ArrayIterator::ARRAY_AS_PROPS);
$iterator->theme = 'dark';
var_dump($settings->theme, $iterator->theme, $iterator->missing);

class ArrayPropertyOverrides extends ArrayIterator {
    public function offsetGet($key): mixed {
        echo "get:$key;";
        return parent::offsetGet($key);
    }
    public function offsetSet($key, $value): void {
        echo "set:$key;";
        parent::offsetSet($key, $value);
    }
    public function offsetExists($key): bool {
        echo "has:$key;";
        return parent::offsetExists($key);
    }
    public function offsetUnset($key): void {
        echo "unset:$key;";
        parent::offsetUnset($key);
    }
}
$iterator = new ArrayPropertyOverrides(['name' => 'Ada', 'count' => 3, 'empty' => null, 'nested' => ['id' => 1]]);
$iterator->setFlags(ArrayIterator::ARRAY_AS_PROPS);
var_dump($iterator->name, $iterator->count++, $iterator->count += 3);
var_dump(isset($iterator->empty), empty($iterator->empty), property_exists($iterator, 'empty'), $iterator->empty ?? 'none');
$iterator->nested['id']++;
unset($iterator->name);
var_dump($iterator->getArrayCopy());

class ArrayPropertySetter extends ArrayObject {
    public function offsetSet($key, $value): void {
        echo "set:$key;";
        parent::offsetSet($key, $value);
    }
}
$setter = new ArrayPropertySetter(['n' => 1], ArrayObject::ARRAY_AS_PROPS);
$setter->n++;
$setter->n += 2;
$setter->new = 5;
var_dump($setter->getArrayCopy());

class ArrayPropertyGetter extends ArrayObject {
    public function offsetGet($key): mixed {
        return ['field' => 1];
    }
}
$getter = new ArrayPropertyGetter([], ArrayObject::ARRAY_AS_PROPS);
try {
    $getter->record++;
} catch (TypeError $error) {
    echo $error->getMessage(), "\n";
}
var_dump($getter->getArrayCopy());

class ThrowingArraySetting {
    public function __destruct() {
        echo 'release;';
        throw new Exception('saved');
    }
}
foreach (['ArrayObject', 'ArrayIterator'] as $class) {
    foreach (['property', 'offset', 'method'] as $access) {
        $data = new $class(['item' => new ThrowingArraySetting], $class::ARRAY_AS_PROPS);
        try {
            if ($access === 'property') $data->item = 5;
            elseif ($access === 'offset') $data['item'] = 5;
            else $data->offsetSet('item', 5);
        } catch (Exception $error) {
            echo $error->getMessage(), ';';
        }
        echo json_encode($data->getArrayCopy()), "\n";
    }
}
