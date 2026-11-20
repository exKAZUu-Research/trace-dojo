<?php
foreach (['array_merge', 'array_merge_recursive'] as $merge) {
    foreach ([true, false] as $emptyFirst) {
        $source = [9 => 1, 'entry' => 2];
        unset($source[9]);
        $copy = $emptyFirst ? $merge([], $source) : $merge($source, []);
        $copy[] = 3;
        echo array_key_last($copy), ':', count($source), "\n";

        $source = [0, 1, 2];
        unset($source[2]);
        $copy = $emptyFirst ? $merge([], $source) : $merge($source, []);
        $copy[] = 3;
        echo array_key_last($copy), "\n";

        $source = [2 => 1, 5 => 2];
        $copy = $emptyFirst ? $merge([], $source) : $merge($source, []);
        echo array_key_last($copy), "\n";

        $source = [];
        $source['cycle'] = &$source;
        $copy = $emptyFirst ? $merge([], $source) : $merge($source, []);
        var_dump($copy);
        unset($source, $copy);
    }
}
