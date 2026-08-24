/**
 * First wave of standalone field documents for BACKROOMS: MEMORY BLEED.
 * Pure data - one dependency on the shared tag type. Voice-matched to
 * NOTE_TEXTS/MORE_NOTES; tags route notes to plausible districts,
 * contamination kinds and story stages via src/content/tags.ts.
 */
import type { TaggedEntry } from './tags';

export const NOTE_WAVE1: TaggedEntry[] = [
{ text: 'MAINTENANCE REQUEST 117: fluorescent unit 5W has started flickering in morse. Translated so far: NOT YET. Requesting a decoder who is brave.', memKinds: ['office'] },
{ text: 'WORK ORDER 63-C: replaced the ceiling tiles over cubicle row nine. By morning the new tiles had grown water stains shaped exactly like the old ones. Keeping the originals as reference.', memKinds: ['office'] },
{ text: 'FACILITIES NOTICE: break room fridge assignments have been corrected. Whatever you find inside this morning was not yours this morning. Label accordingly.', memKinds: ['office', 'residence'] },
{ text: 'REQUEST 121: the copier repair ticket keeps closing itself and stapling a thank-you note to the corkboard. Nobody staples a thank-you note. Audit pending, indefinitely.', memKinds: ['office'] },
{ text: 'OBSERVATION 12: the stairwell handrails continue past the landings, into the walls, still warm. Maintenance says follow them. Follow them where.' },
{ text: 'To IT: my desktop wallpaper changed overnight to a photograph of this desk taken from the doorway. I am the only one with keys, and I lock the door.', memKinds: ['office'], minStage: 1 },
{ text: 'MEMO, ALL STAFF: effective immediately, do not book meetings after 4:45. Rooms booked after 4:45 have been arriving with occupants already seated.', memKinds: ['office'], districts: [1] },
{ text: 'RECEIPT, VENDING MACHINE 2: one coffee, deducted from a card I reported stolen in 2016. It remembered me anyway. The coffee was hot. Small mercies.', memKinds: ['mall'] },
{ text: 'LOST & FOUND INTAKE 44: child’s shoe, left foot only, worn through at the heel like someone grew up in it. No right foot has ever been surrendered. Filing under ongoing.', memKinds: ['mall'], districts: [2] },
{ text: 'MALL DIRECTORY CORRECTION: the second-floor fountain is listed under FIXTURES and again under FORMER TENANTS. Both listings are accurate, depending on the hour.', memKinds: ['mall'], districts: [2] },
{ text: 'SECURITY WALKTHROUGH, LEVEL 2: mannequin count 34 at open, 35 at close. The extra one wears last year’s seasonal display. We stopped doing seasonal displays.', memKinds: ['mall'], districts: [2] },
{ text: 'HOSPITAL INTAKE FORM 9: patient reports a corridor being built around their bed overnight. Attending notes construction quality as good. Patient discharged to a ward that matches the description.', memKinds: ['hospital'] },
{ text: 'PHARMACY RESTOCK LOG: shelf space reserved for a medication nobody has ever prescribed. Boxes keep arriving with today’s date and instructions for tomorrow.', memKinds: ['hospital'] },
{ text: 'VISITING HOURS SIGN, handwritten addition underneath: hours apply to you, not to it. Signed, night staff.', memKinds: ['hospital'], minStage: 1 },
{ text: 'CHAPEL FLYER: weekly service cancelled until further notice. The pews fill before dawn, and whoever sits down does not stand for the hymns.', memKinds: ['hospital'], districts: [2] },
{ text: 'LESSON PLAN, ROOM 112, undated: attendance, recess, fire drill. Under fire drill, one line: they will all line up. In whose order is crossed out.', memKinds: ['school'] },
{ text: 'DETENTION SLIP: reason counted the ceiling tiles out loud. Instructor note: the count came back different every time, and the room agreed with each one.', memKinds: ['school'] },
{ text: 'LIBRARY RETURN CART: one workbook returned completed. Every answer is correct for a school none of us attended. It is in our handwriting.', memKinds: ['school'], minStage: 1 },
{ text: 'GYM NOTICE: floor refinishing in progress. Do not look at your reflection until the sealant dries. It dries at different speeds for different people.', memKinds: ['school'], districts: [3] },
{ text: 'PLATFORM ANNOUNCEMENT, transcript: the 3:33 train is delayed indefinitely. The 3:33 train has always been delayed indefinitely. Please stand behind the yellow line, which goes all the way around.', memKinds: ['transit'], districts: [3] },
{ text: 'LOST PROPERTY, TRANSIT AUTHORITY: one umbrella, dry, folded tight, found open on the platform. It was raining nowhere else on the level.', memKinds: ['transit'] },
{ text: 'SCHEDULE POSTED AT THE TURNSTILES: first train never, last train sooner than that. Management thanks you for waiting poorly.', memKinds: ['transit'], districts: [3] },
{ text: 'Dear Nadia, found a photo booth that takes pictures of the next five minutes. All four shots are of me reading this letter. I am leaving the last frame unexposed for you.', memKinds: ['personal'], districts: [2] },
{ text: 'The hallway outside my door is my hallway. The apartment door is not my door. The door agrees with me. We are both polite about it.', memKinds: ['residence'] },
{ text: 'Note taped inside a kitchen cabinet: we do not run the disposal after dark anymore. Something two floors up answers with its own disposal, closer each night.', memKinds: ['residence'] },
{ text: 'Laundry day 30: the dryer returns everything warm and folded except one sock, which comes back damp and smelling of a house I have never lived in.', memKinds: ['residence', 'personal'] },
{ text: 'The medicine cabinet mirror shows the bathroom with the light on. I have not turned that light on in years. Someone in there is careful with electricity.', memKinds: ['residence'], minStage: 1 },
{ text: 'Child’s height marks on a doorframe here: ages four through ten in pencil, then age ME in crayon at exactly my height. The handwriting is my mother’s.', memKinds: ['residence', 'personal'], minStage: 1 },
{ text: 'EXPEDITION BULLETIN 3: beacon lamps along sector K have begun turning to watch us pass. Cyan holds our way for eleven paces after. Keep walking. They blink politely.', minStage: 1 },
{ text: 'CAMP LEDGER, page 8: batteries 22, pens 9, rope 40m, photographs 4 — do not show it the fourth. All accounted for. Stop asking what the fourth is of.', districts: [4] },
{ text: 'Ration note pinned above the cots: eat facing the wall. Mealtimes are when it looks at faces.', districts: [4], minStage: 1 },
{ text: 'Sleep rotation notice: nobody sleeps twice in the same room anymore. By the second night the rooms remember the shape of us too accurately.', districts: [0] },
{ text: 'Marlow’s rule, posted at camp, third copy: verify a copy by telling it something sad. Copies are never sad for quite long enough.', minStage: 1 },
{ text: 'Reyes left a chair facing the corridor he came in by. He said leave it. When the corridor stops being his, the chair will know first.', minStage: 1 },
{ text: 'Final page of a shared journal, different ink: whoever reads this — we were six, then five, then six again. Ask the sixth what the fifth’s name was. Watch them count.', minStage: 2 },
];
