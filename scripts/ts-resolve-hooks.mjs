// Registers the ".js" -> ".ts" resolve hook. Load with:
//   node --experimental-strip-types --import ./scripts/ts-resolve-hooks.mjs ...

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./ts-resolve.mjs', pathToFileURL(import.meta.filename));
