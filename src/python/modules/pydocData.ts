import { MODULE_DOCS, PYDOC_TOPICS } from '../data/pydocData';
import { registerModule } from '../modules';
import { newDict } from '../types';

// CPython's `pydoc_data` package: the pages `help('for')` shows, and the documentation page of each module.

registerModule('pydoc_data', () => new Map());
registerModule(
  'pydoc_data.topics',
  () => new Map([['topics', newDict(JSON.parse(PYDOC_TOPICS) as [string, string][])]])
);
registerModule(
  'pydoc_data.module_docs',
  () => new Map([['module_docs', newDict(JSON.parse(MODULE_DOCS) as [string, string][])]])
);
