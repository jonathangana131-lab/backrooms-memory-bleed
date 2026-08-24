/**
 * Second wave of standalone field documents for BACKROOMS: MEMORY BLEED.
 * Pure data - one dependency on the shared tag type. Mid-expedition
 * register: the crews have stopped denying the wrongness and started
 * filing it. Tags route notes via src/content/tags.ts.
 */
import type { TaggedEntry } from './tags';

export const NOTE_WAVE2: TaggedEntry[] = [
{ text: 'AUDIT REQUEST 130: every department budget balances to the cent except Facilities, which balances to the minute. Every hour spent down here is accounted for somewhere else.', memKinds: ['office'], minStage: 1 },
{ text: 'PERFORMANCE REVIEW, self-assessment section. Accomplishments: kept the lights believing. Areas for growth: I used to know which ones were mine.', memKinds: ['office'], districts: [1] },
{ text: 'The elevator installed mirrors on all four sides this week. Inspection says capacity is unchanged. It holds however many of you step in, and closes on schedule.', memKinds: ['office', 'transit'], minStage: 1 },
{ text: 'MAINTENANCE LOG, corridor G: mopped the same footprint trail for a week now. It leads out of one wall, crosses the hall, and back into the same wall. I named the mop. It helps.', districts: [3] },
{ text: 'HR BULLETIN: the benefits portal now lists a plan called CONTINUATION. Enrollment is automatic. Opting out requires being missed.', memKinds: ['office'], minStage: 1 },
{ text: 'REQUEST 133: conference room B books itself at 3:15 daily. Attendees unknown. Catering arrives anyway and the trays come back lighter, so we stopped attending in person.', memKinds: ['office'] },
{ text: 'Found my car in the parking structure, level B2. Mileage matches my old commute exactly. There is no exit ramp. I sat in it with the radio off for a while, which felt like commuting.', memKinds: ['mall', 'personal'], districts: [4], minStage: 1 },
{ text: 'FOOD COURT HEALTH INSPECTION: stall seven sells soup from a menu nobody wrote. The pinned reviews describe the taste of specific afternoons. Passed with a recommendation.', memKinds: ['mall'], districts: [2] },
{ text: 'CINEMA 8 MARQUEE, tonight: NOW SHOWING in all eight theatres, the same unlisted film. Ushers report audiences perfect throughout. Nobody has ever seen anyone leave.', memKinds: ['mall'], districts: [2], minStage: 1 },
{ text: 'WARD 3 NIGHT LOG: the patient in bed four rang for water every hour on the hour. Bed four has been empty since 2009. The pitcher empties on schedule. Hydration matters.', memKinds: ['hospital'] },
{ text: 'SURGICAL SCHEDULE, posted blank except one line: routine removal of a memory of falling, patient listed as everyone eventually. OR 2 is always prepped.', memKinds: ['hospital'], minStage: 1 },
{ text: 'MORGUE INTAKE, refused: a body arrived already labelled with a name from our own staff roster. We do not accept transfers from below. It signed itself in anyway.', memKinds: ['hospital'], minStage: 2 },
{ text: 'SCHOOL ANNOUNCEMENTS, read flat over the PA: science fair projects have been judged. First place, the model of this building, scale 1:1, entered by no student on file.', memKinds: ['school'] },
{ text: 'YEARBOOK STAFF NOTE: we photograph every classroom each spring. Developing the film costs a memory apiece. This year we voted to keep the memories undeveloped.', memKinds: ['school'], minStage: 1 },
{ text: 'LOCKER 214, cleaned out per policy: lunchbox, gym shoes, one cassette labelled MIX FOR THE LONG WALK HOME. There is no home on the bus route. Keeping the tape.', memKinds: ['school', 'transit'] },
{ text: 'BUS LOOP DRIVER LOG, final entry: the route runs eight stops forever. Passengers board at their childhood stops and ride toward a depot that was demolished to make room for more route.', memKinds: ['transit'], districts: [3] },
{ text: 'SIGNAL MAINTENANCE, tunnel segment 7: the rails hum the station chime early now, so trains arrive late to their own announcements. We sync the clocks to the hum and call it policy.', memKinds: ['transit'], minStage: 1 },
{ text: 'Dear Chen, you were right about the beacons. The third one held a log in my handwriting, dated Thursday. Today feels like Thursday. Choosing to find that reassuring. I miss you.', memKinds: ['personal'], minStage: 1 },
{ text: 'Kim’s inventory addendum: ring still wrong, wearing still better. For the record — the wrong version fits because the proposal happened in a hallway that did not exist. Consistent. I hate it.', memKinds: ['personal'], minStage: 1 },
{ text: 'For Okafor’s replacement: she walked toward the antiseptic smell on day 60, upright, unhurried, taking notes. If you find tidy handwriting describing this corridor, she got further. Follow the pen strokes, not the maps.', memKinds: ['personal', 'hospital'], minStage: 1 },
{ text: 'RESIDENCE CHECKLIST, laminated, nailed to a bedroom door: windows counted, doors counted, family photos face-down. Newest item, newer marker: stop counting the hallway. The hallway counts back.', memKinds: ['residence'] },
{ text: 'The good china is set for six. We are five. Nobody uses the sixth place setting and nobody clears it either. That would be rude.', memKinds: ['residence'] },
{ text: 'BATH TILE UPDATE: the grout has finished spelling HELP and has begun spelling HELLO. We answered hello first. That was a mistake we are living with.', memKinds: ['residence'], minStage: 1 },
{ text: 'From the backyard the fence repeats to the horizon; from the horizon the house repeats. My mother’s garden blooms between them, out of season, in soil that remembers being carpet.', memKinds: ['residence'], minStage: 1 },
{ text: 'NIGHT AUDIT, SECURITY STATION: camera 9 recorded a room being tidied. Nothing else on the loop moved. Whoever tidies works slower near shift change, like they can hear us breathing.', memKinds: ['office'], minStage: 2 },
{ text: 'ARCHIVE B ACQUISITIONS LOG: today the archive accessioned one (1) expedition. Catalogued under personal effects, condition used, provenance donated unknowingly.', districts: [4], memKinds: ['office'], minStage: 2 },
{ text: 'STOCKTAKE, STORAGE CANTON ZONE: crates hold packing foam moulded around objects removed before sealing. The negatives keep their shapes perfectly. Inventory values the absences higher than the goods.', districts: [4] },
{ text: 'Warehouse aisle 9 is colder on Tuesdays. We do not have Tuesdays. Posting the observation anyway, because the cold deserves acknowledgment.', districts: [4] },
{ text: 'MAZE SURVEY ADDENDUM: mapped junction 41 forty-one times. Forty identical readings, one showing a door we propped open with a thing we agreed not to discuss. Recount mandatory. Not aloud.', districts: [0], minStage: 2 },
{ text: 'Chalk protocol holds: arrows point toward camp again instead of away. Something edits them overnight, badly, like a forger practising. Leave the bad copies up. Confidence is how you catch it.', districts: [0], minStage: 1 },
{ text: 'VOTING RECORD, CAMP COUNCIL: motion to name the corridors failed, four against, two for, one abstention written as a floor plan. Naming gives it handles. It has enough handles.', minStage: 1 },
{ text: 'Water report: coolers dispense colder water the closer you stand to a memory you avoid. Hydration station placement now doubles as a map of the crew.', memKinds: ['personal'], minStage: 1 },
{ text: 'Letter never sent, stamped anyway: Mom — the space built our kitchen and got the chip in the mug wrong. Smaller, deeper, older. It is learning damage. What does it practise on between visits?', memKinds: ['residence', 'personal'], minStage: 2 },
{ text: 'Roster reconciliation, week 12: twelve names in, twelve names present, one of each duplicated. The duplicates stand slightly to the left of themselves and sign attendance without being asked.', minStage: 2 },
{ text: 'PROTOCOL R AMENDMENT: stop leaving happy memories where it can reach them. It builds those rooms faithfully, then furnishes them with the hour before the memory, waiting. Leave weather instead. Weather cannot wait.', minStage: 2 },
];
