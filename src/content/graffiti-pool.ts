/**
 * Expanded graffiti pool for BACKROOMS: MEMORY BLEED.
 * Pure data - one dependency on the shared tag type. Short wall texts in
 * the established register: capitalised, misspelled where it hurts,
 * warnings from people who counted. Consumed by architect.generateGraffiti
 * alongside the legacy pools, hash-selected per chunk.
 */
import type { TaggedEntry } from './tags';

export const GRAFFITI_POOL: TaggedEntry[] = [
{ text: 'THE PAPER KNOWS FIRST' },
{ text: 'ASK ME WHAT I COPIED' },
{ text: 'STILL ON SHIFT', memKinds: ['office'] },
{ text: 'MY HANDS REMEMBER DOORS' },
{ text: 'DO NOT FEED THE HALLWAYS' },
{ text: 'I LEFT BEFORE I ARRIVED' },
{ text: 'THE 41 ROLLS END SOMEWHERE' },
{ text: 'WHO FILED US', memKinds: ['office'] },
{ text: 'COUNT BACKWARDS OUT LOUD' },
{ text: 'IT SAYS THANK YOU' },
{ text: 'THE CHAIRS ARE PATIENT', memKinds: ['office'] },
{ text: 'WE ARE THE SECOND SHIFT NOW', memKinds: ['office'], minStage: 1 },
{ text: 'SIGNED IN NEVER SIGNED OUT', minStage: 1 },
{ text: 'THE HUM HAS LYRICS', minStage: 1 },
{ text: 'CHECK THE MIRRORS LAST', memKinds: ['residence'] },
{ text: 'IT KEEPS MY SEAT WARM', minStage: 1 },
{ text: 'EXIT IS A VERB' },
{ text: 'SOMEONE IS BEING GENTLE WITH THE LIGHTS' },
{ text: 'THIS FLOOR IS SOMEONES KITCHEN', memKinds: ['residence'] },
{ text: 'ALL OUR HANDWRITING MATCHES DOWN HERE', minStage: 2 },
{ text: 'DO NOT ANSWER THE PA', memKinds: ['school'] },
{ text: 'THE VENDING MACHINE TAKES TUESDAYS', memKinds: ['mall'] },
{ text: 'I COUNTED AND I AM SORRY', minStage: 2 },
{ text: 'BE POLITE TO THE DOORS' },
{ text: 'THE MAP GREW A ROOM FOR YOU', districts: [0] },
{ text: 'LAST ONE OUT REMEMBERS THE REST', minStage: 2 },
{ text: 'IT LEARNED ROUNDING', minStage: 3 },
{ text: 'THE FREEZER HOLDS AFTERNOONS', memKinds: ['mall'] },
{ text: 'WARD 6 IS GRATEFUL', memKinds: ['hospital'] },
{ text: 'SHOW YOUR WORK TO NO ONE', memKinds: ['school'] },
{ text: 'THE BELL PRACTICES AT NIGHT', memKinds: ['school'] },
{ text: 'EVERY TRAIN IS THE LAST TRAIN', memKinds: ['transit'] },
{ text: 'YOU MISSED YOUR STOP IN 1996', memKinds: ['transit'] },
{ text: 'THE FOUNTAIN DRINKS BACK', memKinds: ['hospital', 'mall'] },
{ text: 'STOREWIDE MEMORY EVENT', memKinds: ['mall'], districts: [2] },
{ text: 'THIS WALL USED TO BE ELSEWHERE', districts: [4] },
{ text: 'HELLO AGAIN (AGAIN)', minStage: 1 },
{ text: 'AISLE 9 IS COLDER ON TUESDAYS', districts: [4], minStage: 1 },
{ text: 'WHITE LIGHT HOLDS AT 255', minStage: 3 },
{ text: 'LEAVE THE LIGHT ON', minStage: 3 },
];
