import { actions } from './actions';
import { selectors } from './selectors';
import { client } from '../api/client';

export const store = [actions, selectors, client];
