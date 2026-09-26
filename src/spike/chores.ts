/**
 * The fixed eval set: four chores per finale kind, in rounds of [switch, bowl, bell, door, plant] so that any
 * prefix (a --limit run, or a spike stopped by the cost cap) still samples every kind about evenly.
 * Changing the set or its order invalidates comparisons with earlier runs.
 */
export const CHORES: string[] = [
  // round 1
  "turn off the light", "feed the cat", "ring the dinner bell", "close the door", "water the plant",
  // round 2
  "start the coffee machine", "fill the dog's bowl", "wake up my roommate", "open the fridge", "give the cactus a drink",
  // round 3
  "turn on the fan", "serve breakfast cereal", "announce that the laundry is done", "shut the cupboard", "mist the fern",
  // round 4
  "mute the TV", "give the goldfish a snack", "call everyone to the meeting", "let the dog out", "water the tomatoes",
];
