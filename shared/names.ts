// shared/names.ts
// Friendly auto-generated peer names + validation.

export const NAME_REGEX = /^[a-zA-Z0-9_-]+$/;
export const NAME_MAX_LEN = 32;

const ADJECTIVES = [
  "calm","bold","swift","quiet","loud","bright","fuzzy","sly","brave","tidy",
  "glowy","snappy","mellow","nimble","sturdy","gentle","keen","plush","witty","chill",
  "zesty","peppy","breezy","sunny","dusky","sleek","lofty","spry","chirpy","merry",
  "cozy","crisp","jolly","dapper","suave","spunky","prim","proud","quirky","vivid",
  "zany","lush","balmy","hefty","burly","wispy","rosy","sage","brisk","lively"
];

const NOUNS = [
  "fox","panda","otter","hawk","whale","bison","koala","lynx","robin","heron",
  "moose","falcon","yak","seal","gecko","newt","finch","owl","badger","tiger",
  "wolf","crane","bat","crow","swan","lamb","mole","pony","shark","squid",
  "goose","eel","mantis","toad","cub","drake","stork","vole","wren","raven",
  "puma","zebu","llama","ibis","kiwi","quokka","tapir","dodo","civet","lemur"
];

export function generateName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]!;
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]!;
  return `${adj}-${noun}`;
}

export function isValidName(name: string): boolean {
  if (typeof name !== "string") return false;
  if (name.length < 1 || name.length > NAME_MAX_LEN) return false;
  return NAME_REGEX.test(name);
}
