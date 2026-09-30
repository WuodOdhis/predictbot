import { createArena } from '../shared/arena.js';
import { createChain } from '../shared/chain.js';
import { askModel } from './models.js';
import * as store from './store.js';
import './chain.js';

export const { exclusive, createRound, tick, cancelRound } = createArena(
  store,
  createChain(process.env),
  process.env,
  askModel,
);
