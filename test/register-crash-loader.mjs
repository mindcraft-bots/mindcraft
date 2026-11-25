import { register } from 'node:module';

register('./crash-test-loader.mjs', import.meta.url);
