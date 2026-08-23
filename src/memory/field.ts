/**
 * Memory Contamination Engine.
 *
 * Tracks where human memories bled into the Backrooms, what kind they
 * are, how strong they are, and how they evolve (blend, decay, spread).
 */
import { hash2i, fbm2 } from '../core/rng';
import { RNG } from '../core/rng';
import type { MemoryWeather } from './weather';

export const enum MemoryKind {
  NONE = 0,
  RESIDENCE = 1,
  OFFICE = 2,
  HOSPITAL = 3,
  SCHOOL = 4,
  MALL = 5,
  TRANSIT = 6,
  PERSONAL = 7,
}

export const MEMORY_NAMES: Record<number, string> = {
  [MemoryKind.NONE]: '',
  [MemoryKind.RESIDENCE]: 'a home that was never built',
  [MemoryKind.OFFICE]: 'quarterly reports and dead fluorescents',
  [MemoryKind.HOSPITAL]: 'antiseptic and waiting rooms',
  [MemoryKind.SCHOOL]: 'lockers and linoleum echoes',
  [MemoryKind.MALL]: 'fountains, food court, closing time',
  [MemoryKind.TRANSIT]: 'the last train nobody boarded',
  [MemoryKind.PERSONAL]: 'your own footsteps, returned',


