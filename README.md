# @cynosure-mcp/music-tagger

MCP server for automatically identifying and tagging music files using audio fingerprinting (AcoustID + Chromaprint) and metadata from MusicBrainz.

## Tools

| Tool        | Description                                                            |
| ----------- | ---------------------------------------------------------------------- |
| `read_tags` | Read current embedded tags from a file or all music files in a folder  |
| `tag_music` | Fingerprint and write accurate tags (+ cover art) to one or more files |

## Requirements

### API Key

Register for a **free** AcoustID API key at <https://acoustid.org/api-key> and pass it as `ACOUSTID_API_KEY`.

### fpcalc (optional)

The MCP is **fully self-contained** — audio is decoded using the bundled `ffmpeg-static` binary and fingerprinted via `rusty-chromaprint-wasm` (a WASM build of Chromaprint; no native system libraries needed).

If `fpcalc` (Chromaprint CLI) is already installed on the system it will be used automatically as a faster alternative.

| Platform | Install command                                  |
| -------- | ------------------------------------------------ |
| Linux    | `sudo apt install libchromaprint-tools`          |
| macOS    | `brew install chromaprint`                       |
| Windows  | Download from <https://acoustid.org/chromaprint> |

## Configuration

| Variable           | Required | Description                                      |
| ------------------ | -------- | ------------------------------------------------ |
| `ACOUSTID_API_KEY` | Yes      | Free API key from <https://acoustid.org/api-key> |

## Supported Formats

MP3, FLAC, OGG Vorbis, M4A/AAC, WAV, WMA, Opus, APE, Musepack

## Tags Written

- **Title**, **Artist**, **Album Artist**, **Album**
- **Year**, **Track number / total**, **Disc number / total**
- **Genres** (up to 3, from MusicBrainz community votes)
- **Cover art** (250×250 JPEG from Cover Art Archive, embedded)

## MCP Config

```json
{
  "mcpServers": {
    "music-tagger": {
      "command": "npx",
      "args": ["@cynosure-mcp/music-tagger"],
      "env": {
        "ACOUSTID_API_KEY": "your_key_here"
      }
    }
  }
}
```

## How It Works

1. **Decode** — The first 120 s of the audio file is decoded to raw PCM using the bundled `ffmpeg-static` binary
2. **Fingerprint** — `rusty-chromaprint-wasm` (WASM, no system deps) generates an AcoustID-compatible fingerprint; `fpcalc` is used instead when available
3. **Identify** — The fingerprint is submitted to the AcoustID API, which returns a MusicBrainz Recording ID
4. **Fetch metadata** — Full recording metadata (title, artists, releases, genres) is fetched from MusicBrainz
5. **Cover art** — Album artwork is fetched from the Cover Art Archive (250×250)
6. **Write** — All tags are embedded into the file using TagLib (via `node-taglib-sharp`)

MusicBrainz requests are rate-limited to ≤1 req/s as required by their API policy.

## License

MIT
