import { registerSourceModule } from '../sourceModules';
import { SYMTABLE_CORE_SOURCE } from './symtableCoreSource';
import { SYMTABLE_SOURCE } from './symtableSource';

registerSourceModule('_symtable', SYMTABLE_CORE_SOURCE);
registerSourceModule('symtable', SYMTABLE_SOURCE);
