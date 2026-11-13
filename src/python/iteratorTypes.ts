import definitions from './iteratorTypes.json';

type IteratorFeature = 'moved' | 'reduced' | 'hinted';

export const iteratorSamples = Object.values(definitions).map((definition) => definition.sample);

export function iteratorNamesFor(feature: IteratorFeature): Set<string> {
  return new Set(
    Object.entries(definitions)
      .filter(([, definition]) => definition.features.some((candidate) => candidate === feature))
      .map(([name]) => name)
  );
}
