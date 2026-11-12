import { runLibrarySource } from '../librarySource';
import { registerModule } from '../modules';
import { STATISTICS_SOURCE } from './statisticsSource';

registerModule('statistics', () => runLibrarySource('statistics', STATISTICS_SOURCE));
