/**
 * Fourteen cluster story arcs for BACKROOMS: MEMORY BLEED.
 * Pure data - one dependency on the shared tag type. Companion pool to
 * CLUSTER_STORIES in world/architect.ts (same voice contract): mundane
 * paperwork describing impossible escalation, three to five beats per
 * arc, readable in any order but sharper in sequence. Selection is
 * hash-driven in architect.generateNotes; this module never randomises.
 */
import type { TaggedEntry } from './tags';

/** One micro-story: an id plus its escalating beats. */
export interface StoryArc {
  /** Stable kebab-case identifier used by tooling and tests. */
  id: string;
  /** The notes of the arc, in narrative order. */
  beats: TaggedEntry[];
}

export const STORY_ARCS: StoryArc[] = [
  {
    id: 'paper-trail',
    beats: [
      { text: 'PAPER REQUISITION 88-D: ordered forty reams of blank paper. Delivery arrived pre-printed with tomorrow’s incidents, in order, starting with a spill nobody has spilled yet.', memKinds: ['office'] },
      { text: 'PAPER REQUISITION 88-E: using the pre-printed stock by choice now. It is more accurate than our own incident log. We initial its pages and it files them somewhere when we are not looking.', memKinds: ['office'], minStage: 1 },
      { text: 'PAPER REQUISITION 88-F: today’s delivery printed a spill report for a spill that happened while we were reading about it. Timing accurate to the minute. Requesting smaller paper.', memKinds: ['office'], minStage: 1 },
      { text: 'PAPER REQUISITION 88-G, final order: tomorrow’s pages describe an empty room, then footprints, then this requisition being read aloud slowly. We will leave the room exactly as described. It helps to be cooperative.', memKinds: ['office'], minStage: 2 },
    ],
  },
  {
    id: 'night-wash',
    beats: [
      { text: 'LAUNDRY LOG, 03:00: both machines running again though we emptied them at ten. Inside: work shirts, none of ours, name tapes cut out neatly, still warm.', memKinds: ['residence'], districts: [2] },
      { text: 'LAUNDRY LOG, night four: folded whatever dries and stacked it on the bench. By morning the stack is gone and the machines are loaded again. Someone has a very consistent week.', memKinds: ['residence'], districts: [2], minStage: 1 },
      { text: 'LAUNDRY LOG, night nine: left a note in the drum asking who the shirts are for. Morning brought the note back washed, softened, and corrected for grammar. The answer was no.', memKinds: ['residence'], districts: [2], minStage: 1 },
      { text: 'LAUNDRY LOG, final cycle: today’s load includes one shirt with my name tape sewn back on, newer than mine. I did not claim it. Whoever wears my size next will need it more than I do.', memKinds: ['residence'], districts: [2], minStage: 2 },
    ],
  },
  {
    id: 'mileage',
    beats: [
      { text: 'PARKING STRUCTURE B2, ticket audit: every car parked here has been driven recently. Odometers advance overnight in exact commute increments. Nobody drives. The ramp went years ago.', memKinds: ['mall', 'personal'], districts: [4] },
      { text: 'STRUCTURE B2, attendant log: found a car matching mine, down to the bumper sticker peeling at the same corner. Odometer shows my drive to work. I have not worked in months. Drove nothing. Filed under coincidence.', memKinds: ['personal'], districts: [4], minStage: 1 },
      { text: 'STRUCTURE B2, closure notice: the structure now contains one more car than it has spaces, and the count improves every Thursday. We have stopped issuing tickets. The cars always pay anyway.', memKinds: ['mall'], districts: [4], minStage: 2 },
    ],
  },
  {
    id: 'substitute',
    beats: [
      { text: 'STAFF MEMO, SCHOOL WING: a substitute covered grade five today. Sign-in reads MARLOW. Our Marlow signs nothing anymore, and definitely not in chalk dust.', memKinds: ['school'] },
      { text: 'SUBSTITUTE LOG, day three: MARLOW again, then OKAFOR covering gym. Their lesson plans are kind and competent and use our private shorthand. Whoever writes them has read our camp notes closely.', memKinds: ['school'], minStage: 1 },
      { text: 'SUBSTITUTE LOG, day eight: the roster now lists six names. Five are ours. The sixth is REYES, spelled right, which no document down here has ever managed. Reyes says he is flattered. He is not sleeping.', memKinds: ['school'], minStage: 2 },
      { text: 'SUBSTITUTE LOG, last entry: class photo pinned to the staffroom board. Six teachers, our faces, one year older than us, arranged the way family photos arrange. Filed under staffing. Leave it up. It likes being filed.', memKinds: ['school'], minStage: 2 },
    ],
  },
  {
    id: 'hold-music',
    beats: [
      { text: 'PHONE FAULT REPORT: every extension plays hold music between floors now, even off-hook. The tune resolves into the one from my first office job, the year everything was fine.', memKinds: ['office'] },
      { text: 'PHONE FAULT UPDATE: answered a ringing line out of habit. Recorded voice thanked me for my patience and said my call is important to the building. Asked for my extension. Gave it. Regret is ongoing.', memKinds: ['office'], minStage: 1 },
      { text: 'FINAL PHONE LOG: the calls stopped. The quiet after them is worse, like being on hold without the music proving someone is there. Keep one handset off the hook, facing the corridor, as a courtesy.', memKinds: ['office'], minStage: 2 },
    ],
  },
  {
    id: 'water-table',
    beats: [
      { text: 'HYDROLOGY NOTE: the drinking fountains dispense specific summers. The one by radiology is 1989, lake water, sunscreen on the rim. Hydration has become autobiographical.', memKinds: ['hospital', 'transit'] },
      { text: 'HYDROLOGY NOTE 2: mapped the fountain summers against the crew. Everyone’s matches except Chen, whose fountain dispenses a summer she has not had yet. She drinks elsewhere. She is taking this well.', memKinds: ['personal'], minStage: 1 },
      { text: 'AQUIFER SURVEY: below the lowest floor there is water, standing, that reflects rooms instead of ceilings. Soundings come back with weather. Recommend against wells. We drilled one anyway before reading this.', memKinds: ['transit'], minStage: 2 },
      { text: 'WATER TABLE, closing entry: the puddles have started drying upward, and the ceiling is slightly saltier where they land. The aquifer is returning what it borrowed. Do not drink anything that remembers you.', memKinds: ['transit'], minStage: 3 },
    ],
  },
  {
    id: 'laminate',
    beats: [
      { text: 'ADMIN NOTICE: do not laminate your badge. Laminated badges survive too well. Three from the old crew came back through the wall returns slot, glossy, face-out, names legible.', memKinds: ['office'] },
      { text: 'LAMINATION INCIDENT REPORT: found my own badge laminated on the corkboard. I never laminated it. Under the plastic the photo is me from behind. The lamination sealed something into the shape of access.', memKinds: ['office'], minStage: 1 },
      { text: 'BADGE POLICY, revised final: badges now issued unlaminated, unsigned, and slightly wrong on purpose. Accuracy is how doors learn who to keep. May your card read badly forever.', memKinds: ['office'], minStage: 2 },
    ],
  },
  {
    id: 'second-shift',
    beats: [
      { text: 'TIMECARD AUDIT: night-shift cards punch in at 22:00 sharp. Night shift was dissolved in 2011. The machine stamps them anyway, politely, one card per former employee.', memKinds: ['office'], districts: [0] },
      { text: 'SECOND SHIFT OBSERVATION: whoever punches performs the duties. Bins emptied, spills mopped, chairs squared. Work quality excellent. We leave the lights off and tip the break room fridge.', memKinds: ['office'], districts: [0], minStage: 1 },
      { text: 'SECOND SHIFT, week six: my timecard punched at 22:00. I was awake and present and did not punch it. The stamp was warm. HR would say take it up with payroll. Payroll punches at 22:00 too.', memKinds: ['office'], districts: [0], minStage: 2 },
      { text: 'SECOND SHIFT, reconciliation: headcount by day, seven. Headcount by timecard, eight. Management decision: stop reconciling. Whatever the eighth is, it mops better than any of us and asks for nothing but schedule.', memKinds: ['office'], districts: [0], minStage: 2 },
    ],
  },
  {
    id: 'window-dressing',
    beats: [
      { text: 'DISPLAY DEPARTMENT NOTE: the department store windows have been redressed overnight. Scenes from a street I grew up on: bus stop, bakery, rain that fell once in 1994. Mannequins face inward, shy about accuracy.', memKinds: ['mall'], districts: [2] },
      { text: 'WINDOW DRESSING, week two: today’s window shows our camp, rendered tastefully, sale stickers on the sleeping bags. Prices in memories. Everything must go, says the card, gently.', memKinds: ['mall'], districts: [2], minStage: 1 },
      { text: 'WINDOW DRESSING, final display: empty street, our height marks on the doorframe, no figures at all. Card in the corner reads COME SEE US. We will not. The windows understand. They kept the lights on anyway.', memKinds: ['mall'], districts: [2], minStage: 2 },
    ],
  },
  {
    id: 'admission',
    beats: [
      { text: 'ADMISSIONS LEDGER, ward six: new entries appear in a hand we know, dated ahead. First future admission: CHEN, reason listed as CORRIDOR FEVER, expected Tuesday. Chen read it. Chen laughed. Nobody else did.', memKinds: ['hospital'] },
      { text: 'ADMISSIONS LEDGER, page two: entries now include discharge dates, all identical, all reading WHEN THE LIGHTS AGREE. Bed assignments match our camp positions exactly, cot for gurney.', memKinds: ['hospital'], minStage: 1 },
      { text: 'ADMISSIONS LEDGER, page four: a second ledger keeps itself beneath the first, listing visitors. Under every name so far: ME, SOON. Nursing staff have requested we stop reading aloud after dark.', memKinds: ['hospital'], minStage: 2 },
      { text: 'ADMISSIONS LEDGER, page five: my name, dated ahead, reason MEMORY OF FALLING, routine. Beneath it, in kinder ink: NOT YET. The building keeps books both ways. We are learning to prefer its handwriting.', memKinds: ['hospital'], minStage: 3 },
      { text: 'ADMISSIONS LEDGER, closed: every line struck through cleanly, no discharges recorded, just settled. Final page is a floor plan of this camp marked VISITING HOURS. We observe them now, quietly, from the window end.', memKinds: ['hospital'], minStage: 3 },
    ],
  },
  {
    id: 'roll-42',
    beats: [
      { text: 'DECOR SURVEY, west hall: wallpaper repeats every 41 rolls, as documented. Today a seam sits where no seam was. Behind it, plaster, and beneath the plaster, wallpaper. Pattern continues inward.', memKinds: ['residence'] },
      { text: 'ROLL CENSUS, amendment: the pattern runs 41 rolls outward and at least 42 inward. Roll 42 shows our corridor with the furniture mirrored, and one extra chair, facing the wall politely.', memKinds: ['residence'], minStage: 1 },
      { text: 'ROLL 42 FIELD NOTE: peeled back a hand’s width of the outer paper. The inner paper peeled back a hand’s width of its own, revealing us measuring. Resealed both layers. Apologised to the wall. It hummed acceptance.', memKinds: ['residence'], minStage: 2 },
      { text: 'ROLL 42, resolution: we hung a mirror over the seam. The mirror shows the hallway without the seam, and in it the extra chair has turned to face whoever looks. Leave the curtain drawn. Some patterns finish themselves privately.', memKinds: ['residence'], minStage: 3 },
    ],
  },
  {
    id: 'kind-copy',
    beats: [
      { text: 'CAMP MINUTE: a second Kim joined the fire at dinner. Slightly wrong laugh, correct memories, kinder about the dishes. Real Kim verified her with the sad-story rule. The copy passed. That is the part everyone is avoiding.', memKinds: ['personal'], minStage: 2 },
      { text: 'CAMP MINUTE, day three of the copy: she stood watch so half of us could sleep properly. She does not tire. She does not dream. She asked real Kim what dreaming was like and listened like it was weather from home.', memKinds: ['personal'], minStage: 2 },
      { text: 'CAMP MINUTE, vote recorded: the copy stays, five to one, the one being the copy, who voted against herself for our comfort. Motion carried. She thanked us for the consideration. Copies should not be this gracious.', memKinds: ['personal'], minStage: 3 },
      { text: 'CAMP MINUTE, hard entry: the copy walked Reyes to the Threshold line and came back alone, waving the whole way out of sight. She waved until we lost the wave. We keep her minute open. Some rosters end with a kindness nobody wrote.', memKinds: ['personal'], minStage: 3 },
      { text: 'POSTSCRIPT TO THE COPY FILES: this morning both Kims’ bunks were made, hospital corners, and one mug sat poured out on the sill, steaming, going cold politely. Attendance stands at five plus memory. Memory counts.', memKinds: ['personal'], minStage: 3 },
    ],
  },
  {
    id: 'static-choir',
    beats: [
      { text: 'RADIO LOG, tunnel segment 4: every dead radio on the wall hums the same three notes at 03:00. In tune with each other across four kilometres of corridor. Nothing conducts down here except conduct.', memKinds: ['transit'], districts: [3] },
      { text: 'RADIO LOG, fortnight: the hum added a fourth note. Musicologists among us say it is resolving. Ask it not to. We posted signs in the tunnels: PLEASE STAY UNRESOLVED. The hum paused, courteous, then continued.', memKinds: ['transit'], districts: [3], minStage: 1 },
      { text: 'RADIO LOG, final broadcast: tonight the choir hummed our camp-fire song back to us, wordless, a bar behind, getting the harmonies wrong the way family does. We sang louder. Somewhere below, static cleared like a throat, and stayed for the second verse.', memKinds: ['transit'], districts: [3], minStage: 2 },
    ],
  },
  {
    id: 'last-page',
    beats: [
      { text: 'JOURNAL AUDIT: every notebook in camp now ends three pages early. The final pages are filled in already — neat, calm, in our futures’ handwriting. We agreed not to read ahead. Curiosity is losing.', memKinds: ['personal'], minStage: 2 },
      { text: 'JOURNAL AUDIT, page counts holding: my last written page describes writing this audit. It got one detail wrong, deliberately maybe — it spells hope with a capital letter, like a name or a place.', memKinds: ['personal'], minStage: 2 },
      { text: 'JOURNAL AUDIT, exception logged: Marlow’s notebook ends mid-sentence, unfinished, unwritten-past. Either the building does not know her ending, or it is leaving her room to finish. Both possibilities keep the fire going longer.', memKinds: ['personal'], minStage: 3 },
      { text: 'JOURNAL AUDIT, final reconciliation: read the last pages aloud at the fire, as instructed by their own final lines. Together they make one entry: THANK YOU FOR THE MATERIAL. We burned nothing. You do not burn the only copy of a thank you.', memKinds: ['personal'], minStage: 3 },
    ],
  },
];
