#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { File as TagFile, ByteVector, Picture, PictureType } from 'node-taglib-sharp';
import ffmpegStatic from 'ffmpeg-static';
// @ts-expect-error no type declarations
import ffprobeStatic from 'ffprobe-static';
import { fingerprintFromSamples } from 'rusty-chromaprint-wasm';

const execAsync = promisify(exec);

const ACOUSTID_API_KEY = process.env.ACOUSTID_API_KEY;

/** Resolved paths to bundled ffmpeg / ffprobe binaries. */
const FFMPEG_PATH: string = ffmpegStatic as unknown as string;
const FFPROBE_PATH: string = (ffprobeStatic as { path: string }).path;

const SUPPORTED_EXTENSIONS = new Set([
    '.mp3', '.flac', '.ogg', '.m4a', '.aac', '.wav', '.wma', '.opus', '.ape', '.mpc',
]);

// ── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function gatherMusicFiles(dir: string): Promise<string[]> {
    const results: string[] = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...await gatherMusicFiles(fullPath));
        } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
            results.push(fullPath);
        }
    }
    return results.sort();
}

async function collectMusicFiles(inputPath: string): Promise<string[]> {
    const resolved = path.resolve(inputPath);
    const stat = await fs.stat(resolved);
    if (stat.isFile()) {
        const ext = path.extname(resolved).toLowerCase();
        if (!SUPPORTED_EXTENSIONS.has(ext)) {
            throw new Error(`Unsupported file format: ${ext}. Supported: ${[...SUPPORTED_EXTENSIONS].join(', ')}`);
        }
        return [resolved];
    }
    if (stat.isDirectory()) {
        return gatherMusicFiles(resolved);
    }
    throw new Error(`Path is neither a file nor a directory: ${resolved}`);
}

// ── Fingerprinting ────────────────────────────────────────────────────────────

/** Get audio duration (seconds) via the bundled ffprobe. */
async function getAudioDuration(filePath: string): Promise<number> {
    const { stdout } = await execAsync(
        `"${FFPROBE_PATH}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
    );
    return parseFloat(stdout.trim());
}

/**
 * Decode the first 120 s of an audio file to mono s16le PCM at 44 100 Hz
 * using the bundled ffmpeg binary — no system dependencies required.
 */
function decodeAudioPCM(filePath: string): Promise<Int16Array> {
    return new Promise((resolve, reject) => {
        const proc = spawn(FFMPEG_PATH, [
            '-i', filePath,
            '-t', '120',      // AcoustID standard: first 120 s
            '-f', 's16le',    // raw 16-bit signed LE
            '-ac', '1',       // downmix to mono
            '-ar', '44100',   // 44 100 Hz sample rate
            'pipe:1',
        ]);
        const chunks: Buffer[] = [];
        proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
        proc.stderr.on('data', () => { /* suppress ffmpeg console output */ });
        proc.on('error', reject);
        proc.on('close', code => {
            if (code !== 0) {
                reject(new Error(`ffmpeg decode exited with code ${code} for: ${filePath}`));
                return;
            }
            const buf = Buffer.concat(chunks);
            const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
            resolve(samples);
        });
    });
}

/**
 * Fingerprint an audio file.
 * Uses `fpcalc` (Chromaprint CLI) if available in PATH as a fast-path;
 * otherwise falls back to the fully self-contained pipeline:
 *   ffmpeg-static (PCM decode) → rusty-chromaprint-wasm (AcoustID fingerprint).
 */
async function fingerprintFile(filePath: string): Promise<{ duration: number; fingerprint: string }> {
    // Optional fast-path: use fpcalc if installed
    try {
        const escaped = filePath.replace(/'/g, "'\\''");
        const { stdout } = await execAsync(`fpcalc -json '${escaped}'`);
        const data = JSON.parse(stdout) as { duration?: number; fingerprint?: string };
        if (data.fingerprint && data.duration) {
            return { duration: data.duration, fingerprint: data.fingerprint };
        }
    } catch {
        // fpcalc not installed — fall through to the self-contained WASM path
    }

    // Self-contained path: ffmpeg-static (PCM decode) + rusty-chromaprint-wasm
    const [duration, samples] = await Promise.all([
        getAudioDuration(filePath),
        decodeAudioPCM(filePath),
    ]);
    const result = fingerprintFromSamples(44100, 1, samples);
    return { duration, fingerprint: result.compressed };
}

// ── AcoustID ──────────────────────────────────────────────────────────────────

async function acoustidLookup(duration: number, fingerprint: string): Promise<string | null> {
    if (!ACOUSTID_API_KEY) {
        throw new Error('ACOUSTID_API_KEY is not set. Get a free key at https://acoustid.org/api-key');
    }
    const params = new URLSearchParams({
        client: ACOUSTID_API_KEY,
        fingerprint,
        duration: String(Math.round(duration)),
        meta: 'recordings compress',
    });
    const res = await fetch(`https://api.acoustid.org/v2/lookup?${params.toString()}`);
    if (!res.ok) {
        throw new Error(`AcoustID HTTP error ${res.status}: ${await res.text()}`);
    }
    const body = await res.json() as {
        status: string;
        results?: Array<{ score: number; recordings?: Array<{ id: string }> }>;
        error?: { message: string };
    };
    if (body.status !== 'ok') {
        throw new Error(`AcoustID error: ${body.error?.message ?? body.status}`);
    }
    const best = (body.results ?? [])
        .filter(r => r.recordings?.length)
        .sort((a, b) => b.score - a.score)[0];
    return best?.recordings?.[0]?.id ?? null;
}

// ── MusicBrainz ───────────────────────────────────────────────────────────────

const MB_HEADERS = {
    'User-Agent': 'CynosureMusicTagger/1.0.0 (https://github.com/andreasjhagen)',
    'Accept': 'application/json',
};

interface MBRelease {
    id: string;
    title: string;
    date?: string;
    'artist-credit'?: Array<{ name?: string; artist: { name: string } }>;
    media?: Array<{
        position: number;
        'track-count': number;
        tracks?: Array<{ position: number; number: string; title: string }>;
    }>;
    'release-group'?: { id: string; 'primary-type'?: string };
}

interface MBRecording {
    id: string;
    title: string;
    length?: number;
    'artist-credit': Array<{ name?: string; artist: { name: string } }>;
    releases?: MBRelease[];
    genres?: Array<{ name: string; count: number }>;
    tags?: Array<{ name: string; count: number }>;
    isrcs?: string[];
}

async function fetchRecording(mbid: string): Promise<MBRecording> {
    const url = `https://musicbrainz.org/ws/2/recording/${mbid}?inc=artists+releases+genres+tags+isrcs+release-groups&fmt=json`;
    const res = await fetch(url, { headers: MB_HEADERS });
    if (!res.ok) {
        throw new Error(`MusicBrainz error ${res.status} for recording ${mbid}`);
    }
    return res.json() as Promise<MBRecording>;
}

async function fetchCoverArt(releaseId: string): Promise<{ data: Buffer; mimeType: string } | null> {
    try {
        const res = await fetch(`https://coverartarchive.org/release/${releaseId}/front-250`, {
            headers: { 'Accept': 'image/jpeg, image/png, */*' },
        });
        if (!res.ok) return null;
        const ct = res.headers.get('content-type') ?? 'image/jpeg';
        return {
            data: Buffer.from(await res.arrayBuffer()),
            mimeType: ct.split(';')[0].trim(),
        };
    } catch {
        return null;
    }
}

// ── Metadata extraction ───────────────────────────────────────────────────────

interface ResolvedTags {
    title: string;
    artist: string;
    albumArtist?: string;
    album?: string;
    year?: number;
    trackNumber?: number;
    trackTotal?: number;
    discNumber?: number;
    discTotal?: number;
    genres: string[];
    releaseId?: string;
    mbRecordingId: string;
}

function pickBestRelease(releases: MBRelease[]): MBRelease | undefined {
    return releases
        .map(r => {
            const type = (r['release-group']?.['primary-type'] ?? '').toLowerCase();
            const typeScore = type === 'album' ? 3 : type === 'ep' ? 2 : type === 'single' ? 1 : 0;
            const year = r.date ? parseInt(r.date.slice(0, 4)) : 9999;
            return { r, typeScore, year };
        })
        .sort((a, b) => b.typeScore - a.typeScore || a.year - b.year)[0]?.r;
}

function buildTags(rec: MBRecording): ResolvedTags {
    const artist = rec['artist-credit'].map(ac => ac.name ?? ac.artist.name).join(', ');
    const release = rec.releases?.length ? pickBestRelease(rec.releases) : undefined;
    const albumArtist = release?.['artist-credit']?.map(ac => ac.name ?? ac.artist.name).join(', ');
    const year = release?.date ? parseInt(release.date.slice(0, 4)) : undefined;

    let trackNumber: number | undefined;
    let trackTotal: number | undefined;
    let discNumber: number | undefined;
    const discTotal = release?.media?.length;

    if (release?.media) {
        for (const media of release.media) {
            const track = media.tracks?.find(
                t => t.title.toLowerCase() === rec.title.toLowerCase(),
            );
            if (track) {
                trackNumber = track.position;
                trackTotal = media['track-count'];
                discNumber = media.position;
                break;
            }
        }
    }

    const genres = [...(rec.genres ?? []), ...(rec.tags ?? [])]
        .sort((a, b) => b.count - a.count)
        .slice(0, 3)
        .map(g => g.name)
        .filter(Boolean);

    return {
        title: rec.title,
        artist,
        albumArtist,
        album: release?.title,
        year: year !== undefined && !isNaN(year) ? year : undefined,
        trackNumber,
        trackTotal,
        discNumber,
        discTotal: discTotal && discTotal > 1 ? discTotal : undefined,
        genres,
        releaseId: release?.id,
        mbRecordingId: rec.id,
    };
}

// ── Tag I/O ───────────────────────────────────────────────────────────────────

function readCurrentTags(filePath: string): Record<string, unknown> {
    const file = TagFile.createFromPath(filePath);
    try {
        const t = file.tag;
        return {
            title: t.title || null,
            artist: t.performers?.join(', ') || null,
            albumArtist: t.albumArtists?.join(', ') || null,
            album: t.album || null,
            year: t.year || null,
            track: t.track || null,
            trackCount: t.trackCount || null,
            disc: t.disc || null,
            discCount: t.discCount || null,
            genres: t.genres ?? [],
            comment: t.comment || null,
            hasCoverArt: (t.pictures?.length ?? 0) > 0,
        };
    } finally {
        file.dispose();
    }
}

async function applyTags(
    filePath: string,
    tags: ResolvedTags,
    cover: { data: Buffer; mimeType: string } | null,
): Promise<void> {
    const file = TagFile.createFromPath(filePath);
    try {
        const t = file.tag;
        t.title = tags.title;
        t.performers = [tags.artist];
        if (tags.albumArtist) t.albumArtists = [tags.albumArtist];
        if (tags.album) t.album = tags.album;
        if (tags.year !== undefined) t.year = tags.year;
        if (tags.trackNumber !== undefined) t.track = tags.trackNumber;
        if (tags.trackTotal !== undefined) t.trackCount = tags.trackTotal;
        if (tags.discNumber !== undefined) t.disc = tags.discNumber;
        if (tags.discTotal !== undefined) t.discCount = tags.discTotal;
        if (tags.genres.length) t.genres = tags.genres;

        if (cover) {
            const bv = ByteVector.fromByteArray(new Uint8Array(cover.data));
            const pic = Picture.fromFullData(bv, PictureType.FrontCover, cover.mimeType, 'Cover');
            t.pictures = [pic];
        }

        file.save();
    } finally {
        file.dispose();
    }
}

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'music-tagger', version: '1.0.0' });

// ── Tool: read_tags ──────────────────────────────────────────────────────────
server.registerTool(
    'read_tags',
    {
        description: 'Read the current embedded tags from a music file or all music files in a folder.',
        inputSchema: {
            path: z.string().describe('Absolute or relative path to a music file or a folder.'),
        },
    },
    async ({ path: inputPath }) => {
        const files = await collectMusicFiles(inputPath);
        const results = files.map(f => {
            try {
                return { file: path.basename(f), path: f, tags: readCurrentTags(f) };
            } catch (err) {
                return { file: path.basename(f), path: f, error: String(err) };
            }
        });
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
        };
    },
);

// ── Tool: tag_music ──────────────────────────────────────────────────────────
server.registerTool(
    'tag_music',
    {
        description:
            'Identify music files by audio fingerprint (AcoustID + Chromaprint) and write accurate tags ' +
            '(title, artist, album, year, track, disc, genres, cover art) sourced from MusicBrainz. ' +
            'Accepts a single file or a folder path. Requires the ACOUSTID_API_KEY env var and ' +
            'fpcalc (Chromaprint) to be installed on the system.',
        inputSchema: {
            path: z.string().describe('Path to a music file or a folder containing music files.'),
            include_cover_art: z
                .boolean()
                .default(true)
                .describe('Fetch and embed 250×250 album cover art from Cover Art Archive (default: true).'),
            dry_run: z
                .boolean()
                .default(false)
                .describe('Show what tags would be written without modifying files (default: false).'),
        },
    },
    async ({ path: inputPath, include_cover_art, dry_run }) => {
        const files = await collectMusicFiles(inputPath);

        type ResultEntry = {
            file: string;
            status: 'tagged' | 'skipped' | 'error';
            tags?: ResolvedTags;
            coverArtFetched?: boolean;
            error?: string;
        };
        const results: ResultEntry[] = [];

        for (const filePath of files) {
            const fileName = path.basename(filePath);
            try {
                // 1. Fingerprint
                const { duration, fingerprint } = await fingerprintFile(filePath);

                // 2. AcoustID lookup
                const mbid = await acoustidLookup(duration, fingerprint);
                if (!mbid) {
                    results.push({ file: fileName, status: 'skipped', error: 'No AcoustID match found' });
                    await sleep(300);
                    continue;
                }

                // 3. MusicBrainz (respect 1 req/s rate limit)
                await sleep(1100);
                const recording = await fetchRecording(mbid);
                const tags = buildTags(recording);

                // 4. Cover art
                let cover: { data: Buffer; mimeType: string } | null = null;
                let coverArtFetched = false;
                if (include_cover_art && tags.releaseId) {
                    cover = await fetchCoverArt(tags.releaseId);
                    coverArtFetched = cover !== null;
                    if (cover) await sleep(200);
                }

                // 5. Write tags
                if (!dry_run) {
                    await applyTags(filePath, tags, cover);
                }

                results.push({ file: fileName, status: 'tagged', tags, coverArtFetched });
            } catch (err) {
                results.push({ file: fileName, status: 'error', error: String(err) });
                await sleep(500);
            }
        }

        const summary = {
            total: files.length,
            tagged: results.filter(r => r.status === 'tagged').length,
            skipped: results.filter(r => r.status === 'skipped').length,
            errors: results.filter(r => r.status === 'error').length,
            dry_run,
        };

        return {
            content: [{ type: 'text' as const, text: JSON.stringify({ summary, results }, null, 2) }],
        };
    },
);

const transport = new StdioServerTransport();
await server.connect(transport);
