import {createHash} from 'node:crypto';
import type {MediaReference} from './media-reference.ts';

export const mediaKey = (input:string|MediaReference) => createHash('sha256')
  .update(typeof input==='string'?input:input.url+(input.audioUrl?'\naudio:'+input.audioUrl:''))
  .digest('hex');
