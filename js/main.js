// 入口：装好外壳，并给无头复验留一个只读句柄。

import { boot, debug } from './ui/app.js';
import { KINDS, byId } from './puzzles/registry.js';

boot();

window.nikoli = { KINDS, byId, debug };
