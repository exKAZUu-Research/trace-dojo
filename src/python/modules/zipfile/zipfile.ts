// CPython's zipfile package and tarfile module, which run CPython's own code.
import { registerSourceModule } from '../../sourceModules';
import { GLOB_SOURCE } from './globSource';
import { PATH_SOURCE } from './pathSource';
import { TARFILE_SOURCE } from './tarfileSource';
import { ZIPFILE_SOURCE } from './zipfileSource';

registerSourceModule('zipfile', ZIPFILE_SOURCE);
registerSourceModule('zipfile._path', PATH_SOURCE);
registerSourceModule('zipfile._path.glob', GLOB_SOURCE);
registerSourceModule('tarfile', TARFILE_SOURCE);
