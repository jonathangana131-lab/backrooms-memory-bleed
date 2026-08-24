/**
 * F66 Doppelganger letter text pools.
 *
 * Critical phrasings and detail vocabulary the Double draws from when it
 * criticizes the player's recorded choices. Kept beside the other content
 * banks (notes, whispers, graffiti) so every handwritten line in the game
 * lives in src/content/. Pure data -- no imports, no randomness; all
 * selection happens in src/story/doubleletters.ts under the determinism
 * law (src/core/rng.ts only).
 *
 * Template placeholders: '%C' receives a cited choice id, '%D' a detail
 * word seeded from that choice's detailSeed. Three tone levels per kind:
 * level 0 is almost polite, level 2 is the Double at its coldest.
 */

/** The kinds of decisions the Double keeps score of. */
export type ChoiceKind = 'mercy' | 'cruelty' | 'curiosity' | 'avoidance';

/**
 * Critical phrasings per kind and tone level. Index [kind][toneLevel]
 * with toneLevel 0..2 matching TONE_FLOOR..TONE_CEILING in
 * src/story/doubleletters.ts.
 */
export const PHRASINGS: Record<ChoiceKind, string[][]> = {
  mercy: [
    [
      'You spared %C. Kindness down here is a debt someone else collects.',
      'You showed mercy at %C — %D. It was noted. It will be repaid wrong.',
      'You let %C walk away past %D. Gentleness is just a slower appetite.',
    ],
    [
      '%C again — %D this time. You keep sparing things that would not spare you.',
      'Twice-kind now: %C. The walls learn your pattern faster than you do.',
      'You softened again at %C, soft as %D. Mercy repeated stops being mercy.',
    ],
    [
      '%C. %D. How many times will you be gentle before something wears your face better?',
      'You cannot stop saving things — last it was %D at %C. Something is counting.',
      'Every mercy — %C above all — is a thread it pulls tighter around you.',
    ],
  ],
  cruelty: [
    [
      'You hurt %C. I felt it from the other side of the wall.',
      '%C bled because of you. %D still remembers the shape of it. The building approved.',
      'You chose cruelty at %C. It suits you more than you admit.',
    ],
    [
      '%C again. Cruelty is becoming a habit, not a survival.',
      'You did it twice — %C. Your hands remembered before you did.',
      'Second cruelty logged: %C beside %D. The hum got warmer afterward.',
    ],
    [
      '%C. %D. You are practicing. On what, I refuse to imagine.',
      'The cruelty repeats — %C, most recently %D — and each time it looks more like enjoyment.',
      'You keep breaking what finds you: %C. Soon nothing will come find you. Except me.',
    ],
  ],
  curiosity: [
    [
      'You opened what you found at %C — %D. Curiosity is how it learns your routes.',
      '%C — you looked closer. Looking is a door that opens from both sides.',
      'You investigated %C. It appreciated the attention.',
    ],
    [
      '%C again. You peer into everything. Everything peeks back.',
      'Second time you could not resist: %C, even %D. The corridors rearrange for watchers.',
      'You keep leaning in — %C. Lean far enough and the room leans out.',
    ],
    [
      '%C. %D. You catalog the dark like it will thank you.',
      'Your curiosity never ran out — %C saw to that, and %D before it. Neither did its appetite.',
      'Every question you asked at %C was answered by something wearing your handwriting.',
    ],
  ],
  avoidance: [
    [
      'You walked past %C. Avoidance leaves a shape where you refused to look.',
      '%C stayed unopened — so did %D. The hallway remembers refusals longer than rooms.',
      'You turned away from %D at %C. Turning away is still turning.',
    ],
    [
      '%C again. You flinch the same direction every time. Something practices the timing.',
      'Second avoidance: %C. You left %D behind. The unexplored side of you is filling up with them.',
      'You skipped %C like the last one. The skips are drawing a map of your fear.',
    ],
    [
      '%C. %D. You have made avoidance into a home. It has made you into a door.',
      'Always away — %C — never once toward %D. What accumulates behind you does not knock.',
      'Your refusals pile up at %C. One day they will answer for you.',
    ],
  ],
};

/** Detail vocabulary per kind; '%D' slots draw from these, seeded per choice. */
export const DETAILS: Record<ChoiceKind, readonly string[]> = {
  mercy: ['the wet bandage', 'that limping shadow', 'the borrowed coat', 'a half-eaten ration'],
  cruelty: ['the splintered doorframe', 'a smear that dried wrong', 'the kicked-over lamp', 'something small and quiet'],
  curiosity: ['the humming vent', 'that third light switch', 'the mirrored hallway', 'a page of your own handwriting'],
  avoidance: ['the sealed stairwell', 'the door that breathed', 'that too-long corridor', 'the room with your name on it'],
};
