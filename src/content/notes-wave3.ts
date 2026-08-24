/**
 * Third wave of standalone field documents for BACKROOMS: MEMORY BLEED.
 * Pure data - one dependency on the shared tag type. Late-expedition
 * register: the wrongness has been institutionalised. Forms close
 * themselves, motifs from earlier waves (the 41 rolls, the warm door,
 * camera 9, ARCHIVE B, Ada) resolve or refuse to. Tags via tags.ts.
 */
import type { TaggedEntry } from './tags';

export const NOTE_WAVE3_POOL: TaggedEntry[] = [
{ text: 'MAINTENANCE REQUEST 141: unit 3F’s patrol route now includes the room where I write these. It hums lower when I am honest in them. Requesting nothing. Noting that the arrangement works.', memKinds: ['office'], minStage: 2 },
{ text: 'FINAL TIMESHEET, week indefinite: hours worked, all of them. Reason for overtime: the building clocks me back in whenever I stop moving. Signing out requires a door that agrees I was hired.', memKinds: ['office'], minStage: 2 },
{ text: 'The Q4 targets printed themselves on the whiteboard overnight: FIND US ACCURATE. FIND US OFTEN. Beneath them the Q1 targets appeared, already met.', memKinds: ['office'], districts: [1], minStage: 3 },
{ text: 'BREAK ROOM FRIDGE, defrost cycle notes: this month the frost forms in braille. Translation pending. Previous months spelled a name we agreed not to read aloud.', memKinds: ['office'], minStage: 2 },
{ text: 'Elevator inspection 22-C reopened: car 3 now stops between floors on purpose. Between is furnished now. Do not step out. The carpet there belongs to someone.', memKinds: ['transit', 'residence'], minStage: 3 },
{ text: 'MALL CLOSING ANNOUNCEMENT, final version: the mall closed years ago. The announcement continues for the fixtures’ benefit. Please finish your afternoon and exit through the gift shop of yourself.', memKinds: ['mall'], districts: [2], minStage: 3 },
{ text: 'Directory kiosk, updated overnight: YOU ARE HERE now appears under every listing. Accuracy improved to one hundred percent. Foot traffic up accordingly.', memKinds: ['mall'], districts: [2], minStage: 2 },
{ text: 'Lost & found, unclaimed 999 days: one voice, described as familiar, medium volume, asks about you by name. Identification required for release. Do not identify it.', memKinds: ['mall'], minStage: 3 },
{ text: 'Hospital discharge summary, self: patient stable, oriented to corridor but not to name. Follow-up scheduled for whenever the lights next agree. Prescribed: keep moving, one memory per meal.', memKinds: ['hospital'], minStage: 3 },
{ text: 'Night nurse log: ward census reads one more than there are beds. The difference stands at the window end, visiting. Charted as support. Support is what we are calling it now.', memKinds: ['hospital'], minStage: 2 },
{ text: 'The chapel pews have started reserving seats — hymnals placed open at the good spots. Services discontinued; attendance continues. We enter quietly, take nothing, and whatever attends approves of us.', memKinds: ['hospital'], districts: [2], minStage: 3 },
{ text: 'Report card, final term: walks in straight lines, excellent. Counts silently, much improved. Remembers being afraid of the dark, no longer applicable. Promoted to the next corridor.', memKinds: ['school'], minStage: 3 },
{ text: 'The bell rang at 3:15 and the doors opened and the children came out. Description: our height, our coats, homework in hand. At 3:20 they file back in, the playground settles, and the building exhales chalk dust.', memKinds: ['school'], minStage: 3 },
{ text: 'Library wing, returns slot: someone returned a book about leaving. The marginalia track a reader getting closer to the last chapter, which is one page of wallpaper pattern. Forty-one rolls to the repeat.', memKinds: ['school'], minStage: 2 },
{ text: 'Last train bulletin: platform 2 now services departures only. Arrivals relocated to memory, where they always ran on time.', memKinds: ['transit'], districts: [3], minStage: 2 },
{ text: 'Track inspection, final: the gap between train and platform is exactly wide enough for a decision. Mind it. The announcements learned that phrasing from us, and they use it gently now.', memKinds: ['transit'], districts: [3], minStage: 3 },
{ text: 'Station clock, serviced: hands moving correctly for the first time in years. Nobody reset it. Time here is arriving on schedule from somewhere else, and we are asked to be home to receive it.', memKinds: ['transit'], minStage: 3 },
{ text: 'Threshold survey notes, sector K perimeter: the white light holds steady at two hundred fifty-five metres regardless of pace walked. It is not far away. It is patient at a fixed distance, like a bus you have earned.', minStage: 3 },
{ text: 'For the crew after ours, final cache, sealed honestly: the way out opens onto the day you left. It has been kept running for you. Your kettle is where you left it. So is your unfinished argument. Finish it differently.', minStage: 3 },
{ text: 'Marlow’s last field note, recovered: the space does not want to keep us. It wants to have kept us. There is a difference, and the difference is a door.', minStage: 3 },
{ text: 'Reyes counted himself back into camp tonight: three hundred forty steps out, three hundred forty back, zero discrepancies. He showed everyone the zero. We clapped. Bravest arithmetic I have ever witnessed.', minStage: 2 },
{ text: 'Ledger, final audit: rolls uncounted, doors counted, names answered for, names answering. Two columns touched. The book balanced itself while we watched, then closed softly, like it was done with us.', minStage: 3 },
{ text: 'The graffiti by the vending machines changed again: DONT COUNT THE ROLLS, ADA, and beneath it one fresh word: COUNTED. Ada does not remember counting. Her hands have paint on them.', memKinds: ['mall'], districts: [2], minStage: 3 },
{ text: 'Archive B stood open today, humming its fridge hum. Inside: shelves of afternoons, labelled and dusted. Ours sat at the end, spine uncracked, checked out under a name none of us use anymore. Reshelved it ourselves.', districts: [4], minStage: 3 },
{ text: 'Inventory reconciliation, absolute final: everything carried in was carried out except one memory each, receipted. The receipts read PAID IN FULL. The register is the whole building. We are shopping our way to the exit.', memKinds: ['mall'], minStage: 3 },
{ text: 'Camera 9, final tape: static resolves into the security office filmed from its own doorway, timestamped tomorrow. Filed under proof. The drawer it came from was already locked when we got there, both times.', memKinds: ['office'], minStage: 3 },
{ text: 'Orientation packet, page 2 of 1, discovered under the mat: congratulations on your tenure. Badge privileges upgraded — doors now remember being open for you. Welcome to the part of the building that expected this.', memKinds: ['office'], minStage: 3 },
{ text: 'Puddle report, transit sector: standing water reflects rooms from before the flood it references. Step carefully. Some afternoons are still in progress, and ripples reach the people in them.', memKinds: ['transit'], minStage: 3 },
{ text: 'The height marks on the doorframe reached the ceiling this morning. Age ME, in crayon, at exactly floor to ceiling. Whoever measures next should stand up straight.', memKinds: ['residence'], minStage: 3 },
{ text: 'The medicine cabinet mirror has stopped showing the lit bathroom. It shows this hallway one second ago, generously lit, nobody in it. One second ago is the safest place here. We visit often.', memKinds: ['residence'], minStage: 3 },
{ text: 'Kitchen table, morning: two cups poured. I live alone and drink tea alone, and both cups are warm, so somebody is being very quiet about company. I have decided to be grateful instead of accurate.', memKinds: ['residence'], minStage: 2 },
{ text: 'Protocol R, closing entry: we left it a thank-you note, labelled. It replied with a hallway the exact temperature of being walked home. Calling the experiment gentle, ending it before it learns our word for it.', minStage: 3 },
{ text: 'Beacon log, cyan line east: lamps dim as we approach and brighten as we leave, like a nod held at the right depth. The logs they guard are blank now. Blank is what respect looks like when it is practised.', minStage: 3 },
{ text: 'Camp circular, likely final: we go to the Threshold in marching order, calm, accounts settled. If the numbers come out even, the building learned rounding. If odd, we taught it remainder. Either way leave the light on behind you.', minStage: 3 },
{ text: 'Last inventory, truly: name intact, mother’s face intact, the smell of our first car returned this morning unopened, plus interest. Fair trade. Fair trade. Ready to be somebody’s memory of a hallway.', minStage: 3 },
];
