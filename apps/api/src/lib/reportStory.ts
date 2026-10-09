export interface ReportStoryLog {
  entry_type: string;
  title: string | null;
  body: string | null;
  structured_data?: Record<string, unknown> | null;
}

export interface ReportStoryCompanion {
  id: string;
  name: string;
  appearedInPhoto: boolean;
  appearedInVideo: boolean;
}

interface ReportStoryInput {
  petName: string;
  companions: ReportStoryCompanion[];
  logs: ReportStoryLog[];
  photoCount: number;
  includesVideo: boolean;
  coversMultipleDays: boolean;
}

const MOMENT_PATTERNS: Array<{ pattern: RegExp; phrase: string; fact: string }> = [
  { pattern: /play|enrichment|social/i, phrase: "a fun playtime", fact: "playtime" },
  { pattern: /walk|outside|outdoor/i, phrase: "a lovely walk", fact: "walk" },
  { pattern: /feed|meal|breakfast|lunch|dinner/i, phrase: "a happy mealtime", fact: "meal" },
  { pattern: /water|drink|sip/i, phrase: "fresh water and happy sips", fact: "water" },
  { pattern: /rest|nap|sleep|cozy/i, phrase: "a cozy rest", fact: "rest" },
  { pattern: /groom|brush|bath/i, phrase: "a little freshening up", fact: "grooming" },
  { pattern: /potty/i, phrase: "a comfortable potty break", fact: "potty" },
  { pattern: /medication|medicine|meds/i, phrase: "their scheduled care", fact: "medication" },
];

function naturalList(values: string[]) {
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

/**
 * Produces warm but strictly grounded report copy. Every named companion comes
 * from a published assignment on selected media, and every activity phrase
 * comes from a staff-recorded care log. It deliberately does not infer mood,
 * friendship, or activities from pixels alone.
 */
export function generateReportStory(input: ReportStoryInput) {
  const moments: Array<{ phrase: string; fact: string }> = [];
  for (const log of input.logs) {
    const searchable = `${log.entry_type} ${log.title ?? ""} ${log.body ?? ""}`;
    const match = MOMENT_PATTERNS.find((candidate) => candidate.pattern.test(searchable));
    if (match && !moments.some((moment) => moment.fact === match.fact)) moments.push(match);
  }

  const span = input.coversMultipleDays ? "stay" : "day";
  const sentences = [`${input.petName} had a bright, happy ${span} filled with thoughtful care and moments worth sharing.`];
  if (input.companions.length > 0) {
    const companionNames = naturalList(input.companions.map((companion) => companion.name));
    const mediaLabel = input.companions.some((companion) => companion.appearedInVideo)
      ? "selected photos and video"
      : "selected photos";
    sentences.push(`The ${mediaLabel} show ${input.petName} spending time with ${companionNames}, adding some friendly company to the ${span}.`);
  }
  if (moments.length > 0) {
    sentences.push(`The care team also recorded ${naturalList(moments.slice(0, 3).map((moment) => moment.phrase))}.`);
  } else if (input.includesVideo) {
    sentences.push(`The highlight video captures even more of ${input.petName}’s time in motion.`);
  }
  sentences.push(`We loved caring for ${input.petName} and capturing these special moments for the family.`);

  return {
    text: sentences.join(" "),
    facts: {
      source: "confirmed_media_and_staff_logs",
      companionPets: input.companions,
      recordedMoments: moments.map((moment) => moment.fact),
      selectedPhotoCount: input.photoCount,
      selectedVideoIncluded: input.includesVideo,
      coversMultipleDays: input.coversMultipleDays,
    },
  };
}
