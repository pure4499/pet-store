import { spawn } from "node:child_process";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import sharp from "sharp";
import { withOrgScope } from "../db/pool.js";
import { downloadObject, uploadObject } from "../s3/client.js";
import type { ClaimedReportVideo } from "../queue/reportVideoQueue.js";

// ffmpeg-static is CommonJS at runtime while its declaration exposes a default
// export; NodeNext resolves the imported value correctly but needs this narrow
// interop cast for strict TypeScript builds.
const ffmpegBinary = ffmpegPath as unknown as string | null;

const WIDTH = 720;
const HEIGHT = 1280;
const FPS = 30;

type ReportTheme = "storybook" | "timeline_diary" | "care_card" | "photo_journal" | "postcard";
type ReportMusicStyle = "none" | "warm_story" | "day_in_motion" | "gentle_care" | "dreamy_memories" | "sunny_postcard";
type ReportVisualStyle = "clean" | "sticker_dots" | "cartoon_title";

interface MusicTrack {
  chords: [number, number, number, number][];
  bpm: number;
  instrument: "ukulele" | "xylophone" | "marimba" | "glockenspiel" | "toy_piano";
  groove: "swing" | "bounce" | "shaker" | "six_eight" | "march";
  subdivisions: 2 | 3;
  arpPattern: number[];
  leadRhythm: number[];
  bassRhythm: number[];
  chordRhythm: number[];
}

// These short instrumental beds are synthesized at render time from original
// chord progressions. No recorded samples or third-party music are bundled.
const MUSIC_TRACKS: Record<Exclude<ReportMusicStyle, "none">, MusicTrack> = {
  warm_story: {
    chords: [[261.63, 329.63, 392.00, 523.25], [349.23, 440.00, 523.25, 698.46], [392.00, 493.88, 587.33, 783.99], [261.63, 329.63, 392.00, 523.25], [349.23, 440.00, 523.25, 698.46], [293.66, 369.99, 440.00, 587.33], [392.00, 493.88, 587.33, 783.99], [261.63, 329.63, 392.00, 523.25]],
    bpm: 136,
    instrument: "ukulele",
    groove: "swing",
    subdivisions: 2,
    arpPattern: [0, 2, 1, 3, 2, 1, 3, 2],
    leadRhythm: [1, 0, 0.72, 0.42, 1, 0, 0.62, 0],
    bassRhythm: [1, 0, 0.65, 0, 1, 0, 0.65, 0],
    chordRhythm: [1, 0, 0, 0.7, 1, 0, 0, 0.7],
  },
  day_in_motion: {
    chords: [[293.66, 369.99, 440.00, 587.33], [392.00, 493.88, 587.33, 783.99], [440.00, 554.37, 659.25, 880.00], [293.66, 369.99, 440.00, 587.33], [392.00, 493.88, 587.33, 783.99], [329.63, 415.30, 493.88, 659.25], [440.00, 554.37, 659.25, 880.00], [293.66, 369.99, 440.00, 587.33]],
    bpm: 152,
    instrument: "xylophone",
    groove: "bounce",
    subdivisions: 2,
    arpPattern: [0, 1, 2, 3, 2, 3, 1, 2],
    leadRhythm: [1, 0, 0.78, 0, 1, 0.55, 0, 0.72],
    bassRhythm: [1, 0, 0, 0.8, 1, 0.65, 0, 0.8],
    chordRhythm: [1, 0, 0.65, 0, 1, 0, 0.65, 0],
  },
  gentle_care: {
    chords: [[349.23, 440.00, 523.25, 698.46], [466.16, 587.33, 698.46, 932.33], [523.25, 659.25, 783.99, 1046.50], [349.23, 440.00, 523.25, 698.46], [466.16, 587.33, 698.46, 932.33], [392.00, 493.88, 587.33, 783.99], [523.25, 659.25, 783.99, 1046.50], [349.23, 440.00, 523.25, 698.46]],
    bpm: 142,
    instrument: "marimba",
    groove: "shaker",
    subdivisions: 2,
    arpPattern: [0, 2, 1, 2, 3, 2, 1, 2],
    leadRhythm: [1, 0.6, 0, 0.85, 1, 0.6, 0, 0.75],
    bassRhythm: [1, 0, 0, 0, 0.8, 0, 0, 0],
    chordRhythm: [1, 0, 0, 0, 0.75, 0, 0, 0],
  },
  dreamy_memories: {
    chords: [[392.00, 493.88, 587.33, 783.99], [523.25, 659.25, 783.99, 1046.50], [587.33, 739.99, 880.00, 1174.66], [392.00, 493.88, 587.33, 783.99], [523.25, 659.25, 783.99, 1046.50], [440.00, 554.37, 659.25, 880.00], [587.33, 739.99, 880.00, 1174.66], [392.00, 493.88, 587.33, 783.99]],
    bpm: 146,
    instrument: "glockenspiel",
    groove: "six_eight",
    subdivisions: 3,
    arpPattern: [0, 1, 2, 3, 2, 1, 0, 2, 3, 1, 2, 3],
    leadRhythm: [1, 0, 0.62, 0, 0.48, 0, 1, 0, 0.72, 0, 0.52, 0],
    bassRhythm: [1, 0, 0, 0.65, 0, 0, 1, 0, 0, 0.65, 0, 0],
    chordRhythm: [1, 0, 0, 0, 0, 0, 0.8, 0, 0, 0, 0, 0],
  },
  sunny_postcard: {
    chords: [[392.00, 493.88, 587.33, 783.99], [523.25, 659.25, 783.99, 1046.50], [587.33, 739.99, 880.00, 1174.66], [392.00, 493.88, 587.33, 783.99], [523.25, 659.25, 783.99, 1046.50], [587.33, 739.99, 880.00, 1174.66], [392.00, 493.88, 587.33, 783.99], [392.00, 493.88, 587.33, 783.99]],
    bpm: 150,
    instrument: "toy_piano",
    groove: "march",
    subdivisions: 2,
    arpPattern: [0, 2, 3, 1, 2, 3, 2, 1],
    leadRhythm: [1, 0, 0.78, 0.48, 1, 0, 0.82, 0.55],
    bassRhythm: [1, 0, 1, 0, 1, 0, 1, 0],
    chordRhythm: [1, 0, 0.8, 0, 1, 0, 0.8, 0],
  },
};

interface ThemeStyle {
  background: string;
  primary: string;
  ink: string;
  titleEyebrow: string;
}

const THEMES: Record<ReportTheme, ThemeStyle> = {
  storybook: { background: "#F4F1E7", primary: "#176B5B", ink: "#173B35", titleEyebrow: "UCBARKLEY STORY" },
  timeline_diary: { background: "#EAF2EE", primary: "#315C52", ink: "#183B34", titleEyebrow: "DAY IN REVIEW" },
  care_card: { background: "#E8F5F3", primary: "#147363", ink: "#173B35", titleEyebrow: "CARE UPDATE" },
  photo_journal: { background: "#F1E9E1", primary: "#705344", ink: "#3D3029", titleEyebrow: "PHOTO JOURNAL" },
  postcard: { background: "#F8E8DE", primary: "#A85643", ink: "#4B312B", titleEyebrow: "HELLO FROM UCBARKLEY" },
};

interface RenderItem {
  item_type: "photo" | "video" | "log";
  storage_key: string | null;
  content_type: string | null;
}

interface Draft {
  id: string;
  template: ReportTheme;
  music_style: ReportMusicStyle;
  visual_style: ReportVisualStyle;
  title: string;
  closing_caption: string | null;
  story_text: string | null;
  target_seconds: number;
  items: RenderItem[];
}

export async function renderReportVideo(job: ClaimedReportVideo): Promise<void> {
  if (!ffmpegBinary) throw new Error("ffmpeg-static did not provide an FFmpeg binary for this platform");
  const draft = await loadDraft(job);
  const theme = THEMES[draft.template] ?? THEMES.storybook;
  const media = draft.items.filter((item) => item.item_type !== "log" && item.storage_key);
  if (media.length === 0) throw new Error("Report video has no renderable media");

  const workDir = await mkdtemp(join(tmpdir(), `ucbarkley-video-${draft.id}-`));
  try {
    const segments: string[] = [];
    const titleCard = join(workDir, "title.png");
    await createCard(titleCard, theme.titleEyebrow, draft.title, theme, draft.visual_style);
    segments.push(await renderStill(ffmpegBinary, titleCard, join(workDir, "segment-000.mp4"), 1.5, theme.background));

    const videoCount = media.filter((item) => item.item_type === "video").length;
    const photoCount = media.filter((item) => item.item_type === "photo").length;
    const videoSeconds = videoCount > 0 ? 4 : 0;
    const photoSeconds = photoCount > 0
      ? Math.max(2, (draft.target_seconds - 3 - videoSeconds) / photoCount)
      : 0;
    const onlyVideoSeconds = photoCount === 0 ? draft.target_seconds - 3 : videoSeconds;

    for (let index = 0; index < media.length; index += 1) {
      const item = media[index];
      const extension = item.item_type === "video"
        ? (extname(item.storage_key!) || (item.content_type === "video/quicktime" ? ".mov" : ".mp4"))
        : (extname(item.storage_key!) || ".jpg");
      const inputPath = join(workDir, `input-${index}${extension}`);
      await writeFile(inputPath, await downloadObject(item.storage_key!));
      const outputPath = join(workDir, `segment-${String(index + 1).padStart(3, "0")}.mp4`);
      segments.push(
        item.item_type === "video"
          ? await renderClip(ffmpegBinary, inputPath, outputPath, onlyVideoSeconds, theme.background)
          : await renderStill(ffmpegBinary, inputPath, outputPath, photoSeconds, theme.background)
      );
    }

    const closingCard = join(workDir, "closing.png");
    await createCard(
      closingCard,
      "TODAY'S NOTE",
      draft.closing_caption || storyCardText(draft.story_text) || "A happy day at UCBarkley",
      theme,
      draft.visual_style
    );
    segments.push(await renderStill(ffmpegBinary, closingCard, join(workDir, "segment-final.mp4"), 1.5, theme.background));

    const concatList = join(workDir, "segments.txt");
    await writeFile(concatList, segments.map((path) => `file '${path.replaceAll("'", "'\\''")}'`).join("\n"));
    const silentOutputPath = join(workDir, "highlight-silent.mp4");
    const outputPath = join(workDir, "highlight.mp4");
    await runFfmpeg(ffmpegBinary, [
      "-y", "-f", "concat", "-safe", "0", "-i", concatList,
      "-c", "copy", "-movflags", "+faststart", silentOutputPath,
    ]);

    if (draft.music_style === "none") {
      await rename(silentOutputPath, outputPath);
    } else {
      const musicPath = join(workDir, "background-music.m4a");
      await createBackgroundMusic(ffmpegBinary, musicPath, draft.music_style, draft.target_seconds);
      await runFfmpeg(ffmpegBinary, [
        "-y", "-i", silentOutputPath, "-i", musicPath,
        "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
        "-t", draft.target_seconds.toFixed(3), "-movflags", "+faststart", outputPath,
      ]);
    }

    const outputKey = `report-videos/${job.organizationId}/${draft.id}/highlight.mp4`;
    await uploadObject(outputKey, await readFile(outputPath), "video/mp4");
    await withOrgScope(job.organizationId, (client) =>
      client.query(
        `UPDATE report_video_drafts
         SET status = 'ready', output_storage_key = $1, actual_seconds = $2,
             render_error = NULL, updated_at = now()
         WHERE id = $3 AND organization_id = $4 AND status = 'rendering'`,
        [outputKey, draft.target_seconds, draft.id, job.organizationId]
      )
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function loadDraft(job: ClaimedReportVideo): Promise<Draft> {
  return withOrgScope(job.organizationId, async (client) => {
    const result = await client.query(
      `SELECT id, template, music_style, visual_style, title, closing_caption, story_text, target_seconds
       FROM report_video_drafts WHERE id = $1 AND organization_id = $2 AND status = 'rendering'`,
      [job.id, job.organizationId]
    );
    if (!result.rows[0]) throw new Error("Claimed report-video draft was not found");
    const items = await client.query(
      `SELECT i.item_type,
              CASE WHEN i.item_type = 'photo' THEN p.storage_key ELSE v.storage_key END AS storage_key,
              v.content_type
       FROM report_video_items i
       LEFT JOIN photos p ON p.id = i.photo_id
         AND p.organization_id = i.organization_id AND p.deleted_at IS NULL
       LEFT JOIN videos v ON v.id = i.video_id
       WHERE i.report_video_id = $1 AND i.organization_id = $2
         AND (i.item_type <> 'photo' OR p.id IS NOT NULL)
       ORDER BY i.sort_order`,
      [job.id, job.organizationId]
    );
    const template = result.rows[0].template in THEMES ? result.rows[0].template as ReportTheme : "storybook";
    const musicStyle = result.rows[0].music_style in MUSIC_TRACKS || result.rows[0].music_style === "none"
      ? result.rows[0].music_style as ReportMusicStyle
      : "warm_story";
    const visualStyle = (["clean", "sticker_dots", "cartoon_title"] as string[]).includes(result.rows[0].visual_style)
      ? result.rows[0].visual_style as ReportVisualStyle
      : "clean";
    return { ...result.rows[0], template, music_style: musicStyle, visual_style: visualStyle, target_seconds: Number(result.rows[0].target_seconds), items: items.rows };
  });
}

function storyCardText(story: string | null): string {
  if (!story) return "";
  const firstSentence = story.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() || story.trim();
  return firstSentence.length > 120 ? `${firstSentence.slice(0, 117).trimEnd()}...` : firstSentence;
}

export async function createBackgroundMusic(binary: string, output: string, style: Exclude<ReportMusicStyle, "none">, seconds: number): Promise<void> {
  const track = MUSIC_TRACKS[style];
  const wavPath = `${output}.source.wav`;
  await writeFile(wavPath, synthesizeUpbeatMusic(track, seconds));
  try {
    await runFfmpeg(binary, [
      "-y", "-i", wavPath,
      "-af", `afade=t=in:st=0:d=0.08,afade=t=out:st=${Math.max(0, seconds - 0.35).toFixed(3)}:d=0.35`,
      "-t", seconds.toFixed(3), "-c:a", "aac", "-b:a", "160k", output,
    ]);
  } finally {
    await rm(wavPath, { force: true });
  }
}

function synthesizeUpbeatMusic(track: MusicTrack, seconds: number): Buffer {
  const sampleRate = 48_000;
  const sampleCount = Math.ceil(sampleRate * seconds);
  const wav = Buffer.allocUnsafe(44 + sampleCount * 2);
  writeWavHeader(wav, sampleCount, sampleRate);
  const beatSeconds = 60 / track.bpm;
  const stepSeconds = beatSeconds / track.subdivisions;

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const time = sampleIndex / sampleRate;
    const beatIndex = Math.floor(time / beatSeconds);
    const stepIndex = Math.floor(time / stepSeconds);
    const stepPhase = time - stepIndex * stepSeconds;
    const chord = track.chords[Math.floor(beatIndex / 2) % track.chords.length];
    const melodyFrequency = chord[track.arpPattern[stepIndex % track.arpPattern.length]];
    const leadAccent = track.leadRhythm[stepIndex % track.leadRhythm.length];
    const bassAccent = track.bassRhythm[stepIndex % track.bassRhythm.length];
    const chordAccent = track.chordRhythm[stepIndex % track.chordRhythm.length];

    const leadDecay = track.instrument === "xylophone" ? 30 : track.instrument === "marimba" ? 22 : track.instrument === "ukulele" ? 17 : track.instrument === "glockenspiel" ? 11 : 18;
    const melodyEnvelope = Math.exp(-stepPhase * leadDecay / stepSeconds);
    const melodyPhase = time * melodyFrequency;
    const melody = instrumentWave(track.instrument, melodyPhase)
      * melodyEnvelope * 0.145 * leadAccent;

    const chordEnvelope = Math.exp(-stepPhase * (track.instrument === "ukulele" ? 14 : 11) / stepSeconds);
    const chordPulse = chord.slice(0, 3).reduce(
      (sum, frequency) => sum + instrumentWave(track.instrument, time * frequency),
      0
    ) * chordEnvelope * 0.022 * chordAccent;

    const bassFrequency = chord[0] / 2;
    const bass = Math.sin(2 * Math.PI * time * bassFrequency)
      * Math.exp(-stepPhase * 5 / stepSeconds) * 0.14 * bassAccent;

    const percussion = percussionHits(track.groove, stepIndex, track.subdivisions);
    const kick = percussion.kick && stepPhase < 0.14
      ? Math.sin(2 * Math.PI * (92 * stepPhase - 135 * stepPhase * stepPhase)) * Math.exp(-stepPhase * 24) * 0.22
      : 0;
    const snareNoise = deterministicNoise(sampleIndex);
    const snare = percussion.snare && stepPhase < 0.11
      ? snareNoise * Math.exp(-stepPhase * 34) * percussion.snareLevel
      : 0;
    const hat = percussion.hatLevel > 0 && stepPhase < 0.045
      ? (deterministicNoise(sampleIndex * 7) - deterministicNoise((sampleIndex - 1) * 7))
        * Math.exp(-stepPhase * 92) * percussion.hatLevel
      : 0;

    const entrance = Math.min(1, time / 0.08);
    const exit = Math.min(1, Math.max(0, (seconds - time) / 0.32));
    const mixed = Math.tanh((melody + chordPulse + bass + kick + snare + hat) * 1.35) * entrance * exit;
    wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, mixed)) * 32767), 44 + sampleIndex * 2);
  }
  return wav;
}

function instrumentWave(instrument: MusicTrack["instrument"], cycles: number): number {
  const phase = 2 * Math.PI * cycles;
  // Rounded, short-decay timbres keep the beds closer to playful acoustic
  // children's music than exposed square/saw oscillators.
  if (instrument === "ukulele") return Math.sin(phase) * 0.52 + triangle(cycles) * 0.26 + Math.sin(phase * 2) * 0.15 + Math.sin(phase * 3) * 0.07;
  if (instrument === "xylophone") return Math.sin(phase) * 0.62 + Math.sin(phase * 3) * 0.25 + Math.sin(phase * 5) * 0.13;
  if (instrument === "marimba") return Math.sin(phase) * 0.68 + Math.sin(phase * 3) * 0.22 + Math.sin(phase * 5) * 0.10;
  if (instrument === "glockenspiel") return Math.sin(phase) * 0.64 + Math.sin(phase * 2.01) * 0.21 + Math.sin(phase * 3.98) * 0.10 + Math.sin(phase * 5.43) * 0.05;
  return Math.sin(phase) * 0.58 + triangle(cycles) * 0.18 + Math.sin(phase * 2) * 0.16 + Math.sin(phase * 4) * 0.08;
}

function percussionHits(groove: MusicTrack["groove"], stepIndex: number, subdivisions: number) {
  const fourBeatBar = subdivisions * 4;
  const step = stepIndex % fourBeatBar;
  if (groove === "bounce") {
    return { kick: [0, 3, 4, 6].includes(step), snare: [2, 6].includes(step), snareLevel: 0.11, hatLevel: step % 2 ? 0.026 : 0.045 };
  }
  if (groove === "shaker") {
    return { kick: [0, 4].includes(step), snare: [2, 6].includes(step), snareLevel: 0.065, hatLevel: step % 2 ? 0.052 : 0.032 };
  }
  if (groove === "six_eight") {
    const sixStep = stepIndex % 6;
    return { kick: sixStep === 0, snare: sixStep === 3, snareLevel: 0.075, hatLevel: [0, 3].includes(sixStep) ? 0.052 : 0.029 };
  }
  if (groove === "march") {
    return { kick: [0, 4].includes(step), snare: [2, 6].includes(step) || step % 2 === 1, snareLevel: step % 2 === 1 ? 0.038 : 0.12, hatLevel: 0.018 };
  }
  return { kick: [0, 4].includes(step), snare: [2, 6].includes(step), snareLevel: 0.105, hatLevel: step % 2 ? 0.026 : 0.041 };
}

function triangle(cycles: number): number {
  return 2 * Math.abs(2 * (cycles - Math.floor(cycles + 0.5))) - 1;
}

function deterministicNoise(seed: number): number {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return (value - Math.floor(value)) * 2 - 1;
}

function writeWavHeader(buffer: Buffer, sampleCount: number, sampleRate: number): void {
  const dataBytes = sampleCount * 2;
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);
}

export async function createCard(path: string, eyebrow: string, main: string, theme: ThemeStyle = THEMES.storybook, visualStyle: ReportVisualStyle = "clean"): Promise<void> {
  const lines = wrapText(main, 24, 4);
  const lineHeight = 68;
  const startY = 725 - ((lines.length - 1) * lineHeight) / 2;
  const textLines = lines
    .map((line, index) => `<tspan x="360" y="${startY + index * lineHeight}">${escapeXml(line)}</tspan>`)
    .join("");
  const decorations = visualStyle === "sticker_dots"
    ? `<circle cx="612" cy="150" r="62" fill="${theme.primary}" stroke="white" stroke-width="8" stroke-dasharray="5 10"/><text x="612" y="171" text-anchor="middle" fill="white" font-family="DejaVu Sans" font-size="58">★</text><path d="M92 102 H628 V1178 H92 Z" fill="none" stroke="${theme.primary}" stroke-width="7" stroke-dasharray="3 18" stroke-linecap="round"/>`
    : "";
  const titleAttributes = visualStyle === "cartoon_title"
    ? `font-family="DejaVu Sans" font-size="55" font-weight="900" stroke="${theme.primary}" stroke-width="2" paint-order="stroke" transform="rotate(-2 360 725)"`
    : `font-family="DejaVu Sans" font-size="52" font-weight="700"`;
  const svg = `
    <svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="${theme.background}"/>
      ${decorations}
      <rect x="270" y="355" width="180" height="180" rx="52" fill="${theme.primary}"/>
      <text x="360" y="465" text-anchor="middle" fill="white" font-family="DejaVu Sans" font-size="58" font-weight="700">TT</text>
      <text x="360" y="620" text-anchor="middle" fill="${theme.primary}" font-family="DejaVu Sans" font-size="27" font-weight="700" letter-spacing="5">${escapeXml(eyebrow)}</text>
      <text text-anchor="middle" fill="${theme.ink}" ${titleAttributes}>${textLines}</text>
    </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(path);
}

function wrapText(value: string, maxCharacters: number, maxLines: number): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  for (const word of words) {
    const current = lines.at(-1);
    if (!current || current.length + word.length + 1 > maxCharacters) {
      if (lines.length === maxLines) {
        lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, maxCharacters - 1)}…`;
        break;
      }
      lines.push(word.slice(0, maxCharacters));
    } else {
      lines[lines.length - 1] = `${current} ${word}`;
    }
  }
  return lines.length > 0 ? lines : ["A happy day"];
}

async function renderStill(binary: string, input: string, output: string, seconds: number, background: string): Promise<string> {
  await runFfmpeg(binary, [
    "-y", "-loop", "1", "-i", input, "-t", seconds.toFixed(3),
    "-vf", `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=${background.slice(1)},fade=t=in:st=0:d=0.25,fade=t=out:st=${Math.max(0, seconds - 0.25).toFixed(3)}:d=0.25,format=yuv420p`,
    "-r", String(FPS), "-an", "-c:v", "libx264", "-preset", "veryfast", output,
  ]);
  return output;
}

async function renderClip(binary: string, input: string, output: string, seconds: number, background: string): Promise<string> {
  await runFfmpeg(binary, [
    "-y", "-i", input, "-t", seconds.toFixed(3),
    "-vf", `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=${background.slice(1)},tpad=stop_mode=clone:stop_duration=${seconds.toFixed(3)},fade=t=in:st=0:d=0.2,fade=t=out:st=${Math.max(0, seconds - 0.2).toFixed(3)}:d=0.2,format=yuv420p`,
    "-r", String(FPS), "-an", "-c:v", "libx264", "-preset", "veryfast", output,
  ]);
  return output;
}

async function runFfmpeg(binary: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const process = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    process.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_000); });
    process.on("error", reject);
    process.on("close", (code) => code === 0 ? resolve() : reject(new Error(`FFmpeg exited ${code}: ${stderr}`)));
  });
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (character) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;",
  })[character]!);
}
