# tools-data

Zero-dependency Node.js tools for data wrangling: CSV, JSON, ZIP, XLSX, SQLite headers, image metadata, and text analytics. Hand-written parsers, no dependencies, no native modules.

```bash
node tools/csvpeek.js data.csv
node tools/csvsql.js data.csv "SELECT name, score FROM t WHERE score > 7"
node tools/xlsx2csv.js report.xlsx
node tools/zipmedic.js archive.zip
```

Requirements: Node.js 18+ (ESM). No dependencies.

## How it works

```
_ lib.js        shared argv parser, table renderer, stdin/line helpers
tools/*.js      one file per tool, self-contained, --help on every one
index-tools.js  rescans tools/ and regenerates the catalogue below
smoke.js        runs every tool with --help and reports pass/fail
catalogue.json  machine-readable catalogue
```

Each tool declares its own metadata:

```js
// @tool csvpeek
// @desc CSV/TSV: infer delimiter, per-column types, row count, sample
// @usage node tools/csvpeek.js data.csv --json
// @tags data,csv,cli
```

`node index-tools.js` rebuilds the README table from those blocks.

Every tool supports `--json`. Exit codes: `0` clean, `1` problems, `2` gate tripped.

## Real parsers, not regex toys

The interesting files here do actual binary work:

- `zipmedic.js` reads the ZIP central directory, verifies CRCs and names every entry.
- `xlsx2csv.js` opens the ZIP container, inflates `sharedStrings.xml` and the sheet XML with `zlib.inflateRawSync`, and resolves cell types.
- `sqlitepeek.js` parses a SQLite file header and the schema page to list tables without a driver.
- `exifread.js` walks the JPEG APP1 TIFF structure to pull camera, orientation, and GPS.
- `sortbig.js` does an external merge sort with a min-heap so files bigger than RAM still sort.

## Discipline

- Read-only everywhere. Nothing rewrites your source files; output goes to stdout, `--out`, or a preview.
- `renamebatch.js` defaults to dry-run and emits an undo script.
- Ragged, quoted, BOM-prefixed, mixed-delimiter CSV is the normal case here, not the exception.

## Catalogue

<!-- CATALOGUE:START -->

**60 tools**

| Tool | Description | Tags | Usage |
|---|---|---|---|
| [`baseconv`](tools/baseconv.js) | Convert integers between bases 2-36 with BigInt precision and bit utilities | numbers, convert, cli | `node tools/baseconv.js "deadbeef" --from 16 --to 2` |
| [`binarydiff`](tools/binarydiff.js) | Byte-level diff of two binaries with offset-anchored hunks, resync and per-region entropy | data, binary, diff, cli | `node tools/binarydiff.js old.bin new.bin --json` |
| [`binsplit`](tools/binsplit.js) | Split a binary into size-bounded or pattern-anchored chunks and verify reassembly by checksum | data, binary, cli | `node tools/binsplit.js dump.bin --chunk 1m --out ./parts --json` |
| [`bmpread`](tools/bmpread.js) | Parse BMP files: DIB variant, geometry, bit depth, compression, palette and pixel-byte validation | data, image, binary, cli | `node tools/bmpread.js image.bmp --json` |
| [`byterange`](tools/byterange.js) | Extract, replace or XOR/patch byte ranges in a file, with offsets, hex and SHA-256 verification | data, binary, patch, cli | `node tools/byterange.js firmware.bin --at 0x100 --len 64 --json` |
| [`carver`](tools/carver.js) | Carve JPEG/PNG/GIF/PDF/ZIP/ELF/MP4 payloads out of a raw blob with size validation | data, forensics, binary, cli | `node tools/carver.js disk.img --out ./recovered --json` |
| [`cpio`](tools/cpio.js) | Read cpio archives (newc/crc/odc/binary) listing names, sizes, inodes and modes | data, archive, cli | `node tools/cpio.js rootfs.cpio.gz --json` |
| [`csvdiff`](tools/csvdiff.js) | Key-based CSV diff reporting added, removed and changed rows field by field | data, csv, diff, cli | `node tools/csvdiff.js old.csv new.csv --key id` |
| [`csvfix`](tools/csvfix.js) | Repair malformed CSV: strip BOM, fix quote imbalance, normalize delimiters and widths | data, csv, repair, cli | `node tools/csvfix.js broken.csv --report` |
| [`csvjoin`](tools/csvjoin.js) | Inner/left/right/full join of two CSVs on a key column with unmatched counts | data, csv, cli | `node tools/csvjoin.js left.csv right.csv --on id --how left` |
| [`csvjson`](tools/csvjson.js) | Convert between CSV and JSON in either direction with RFC4180 quoting | data, csv, json, convert, cli | `node tools/csvjson.js data.csv --to json --typed` |
| [`csvpeek`](tools/csvpeek.js) | Sniff delimiter, headers, column types, uniqueness and a sample from a CSV/TSV file | data, csv, cli | `node tools/csvpeek.js data.csv --rows 5` |
| [`csvsample`](tools/csvsample.js) | Single-pass reservoir/head/systematic sampling of a huge CSV with O(1) memory | data, csv, sampling, cli | `node tools/csvsample.js huge.csv --n 100 --seed 42 --json` |
| [`csvsql`](tools/csvsql.js) | Query a CSV file with a SQL subset: SELECT cols WHERE cond ORDER BY LIMIT | data, csv, sql, cli | `node tools/csvsql.js data.csv "SELECT name, age WHERE age > 30 ORDER BY age DESC LIMIT 5"` |
| [`datecalc`](tools/datecalc.js) | Date arithmetic: shift dates, diff two dates, business-day math, ISO week | time, date, cli | `node tools/datecalc.js 2026-03-01 --add 45d --workdays` |
| [`dupefind`](tools/dupefind.js) | Find duplicate files by size-then-hash, report reclaimable bytes and clusters | files, dedupe, disk, cli | `node tools/dupefind.js ./photos --min-size 1kb` |
| [`entropyscan`](tools/entropyscan.js) | Per-block Shannon entropy map of a file to locate encrypted, compressed or embedded payloads | data, binary, forensics, cli | `node tools/entropyscan.js firmware.bin --block 256 --json` |
| [`exifread`](tools/exifread.js) | Parse JPEG EXIF: camera, exposure, orientation, timestamps, GPS coordinates | media, images, exif, metadata, cli | `node tools/exifread.js photo.jpg --json` |
| [`filetype`](tools/filetype.js) | Identify file types from magic bytes (90+ formats) plus container-level details | data, binary, forensics, cli | `node tools/filetype.js mystery.bin --json` |
| [`freqcount`](tools/freqcount.js) | Word/line/n-gram frequency counts with stopwords, stemming-lite and TF tables | text, analysis, frequency, cli | `node tools/freqcount.js book.txt --mode words --top 25` |
| [`graphtext`](tools/graphtext.js) | Render sparklines, bars, histograms, scatter and boxplots from numeric series with no dependencies | data, charts, cli | `node tools/graphtext.js series.txt --chart bar --json` |
| [`hashdir`](tools/hashdir.js) | Hash a directory tree into a manifest and verify it later, detecting drift | files, hashing, integrity, cli | `node tools/hashdir.js ./src --algo sha256 --out manifest.json` |
| [`hexdumpx`](tools/hexdumpx.js) | Configurable hexdump with grouping, offset base and reverse mode back into binary | data, binary, hex, cli | `node tools/hexdumpx.js firmware.bin --width 32 --base 0 --json` |
| [`icoextract`](tools/icoextract.js) | Enumerate and extract the PNG/BMP frames inside ICO and CUR icon files | data, image, binary, cli | `node tools/icoextract.js app.ico --out ./icons --json` |
| [`imgdim`](tools/imgdim.js) | Read width/height/format from PNG, JPEG, GIF, WebP, BMP and TIFF headers | media, images, metadata, cli | `node tools/imgdim.js photo.jpg logo.png --json` |
| [`iniscan`](tools/iniscan.js) | Parse INI/config files and audit duplicates, quoting inconsistencies, whitespace and secret-looking values | data, config, cli | `node tools/iniscan.js app.ini --json` |
| [`jsondiff`](tools/jsondiff.js) | Structural JSON diff with JSON-pointer paths, type changes and array diffing | data, json, diff, cli | `node tools/jsondiff.js a.json b.json --json` |
| [`jsonflatten`](tools/jsonflatten.js) | Flatten nested JSON to dotted paths (or rebuild it) with collision detection and round-trip verification | data, json, cli | `node tools/jsonflatten.js nested.json --sep . --verify --json` |
| [`jsongrid`](tools/jsongrid.js) | Flatten a nested JSON array/object into an aligned table with discovered columns | data, json, table, cli | `node tools/jsongrid.js data.json --depth 3 --json` |
| [`jsoninfer`](tools/jsoninfer.js) | Infer a JSON Schema (draft-style) from sample data, merging arrays of objects | data, json, schema, cli | `node tools/jsoninfer.js api-dump.json --required` |
| [`jsonlines`](tools/jsonlines.js) | Convert between NDJSON and JSON arrays, filter with predicates, sample rows | data, json, ndjson, cli | `node tools/jsonlines.js events.ndjson --to array --grep error` |
| [`jsonlint`](tools/jsonlint.js) | Lint JSON for duplicate keys, big-integer precision loss, BOM, comments, NaN, trailing data and deep nesting | data, json, lint, cli | `node tools/jsonlint.js data.json --json` |
| [`jsonmask`](tools/jsonmask.js) | Mask or redact email/phone/card/IP/name/secret fields in JSON with a policy file and audit trail | data, json, privacy, cli | `node tools/jsonmask.js users.json --policy pii.json --style hash --json` |
| [`jsonmerge`](tools/jsonmerge.js) | Deep merge multiple JSON files with last-wins/keep-first/error policies and a full conflict report | data, json, cli | `node tools/jsonmerge.js base.json override.json --policy last --json` |
| [`jsonpath`](tools/jsonpath.js) | Query JSON with a JSONPath subset ($ .key [n] [*] ..key) and set values in place | data, json, query, cli | `node tools/jsonpath.js data.json '$.items[*].name' --json` |
| [`jsonsplit`](tools/jsonsplit.js) | Split a JSON array into count- or size-bounded shards plus a verifiable index manifest | data, json, cli | `node tools/jsonsplit.js big.json --parts 8 --out ./shards --json` |
| [`logtail`](tools/logtail.js) | Tail a log file with grep/level filters, follow simulation, JSON and histogram | logs, text, cli | `node tools/logtail.js app.log --lines 100 --grep ERROR --json` |
| [`mp4box`](tools/mp4box.js) | Walk an MP4/ISO-BMFF box tree and report tracks, durations, codecs and handler types | data, video, binary, cli | `node tools/mp4box.js clip.mp4 --json` |
| [`netflowstat`](tools/netflowstat.js) | Roll up flow records by source, destination, port and ASN-ish group with top-N and share tables | data, network, cli | `node tools/netflowstat.js flows.csv --by src,dst --top 15 --json` |
| [`numberfmt`](tools/numberfmt.js) | Format numbers as grouped, SI/IEC byte, significant-figure, scientific or engineering notation | data, numbers, cli | `node tools/numberfmt.js 1234567.891 --mode bytes --json` |
| [`renamebatch`](tools/renamebatch.js) | Regex bulk renamer with dry-run preview, collision detection and undo script | files, rename, batch, cli | `node tools/renamebatch.js ./shots --find 'IMG_(\\d+)' --replace 'photo-$1' --dry-run` |
| [`schemadump`](tools/schemadump.js) | Parse CREATE TABLE/INDEX statements out of a SQL dump into a structured schema with keys and columns | data, sql, schema, cli | `node tools/schemadump.js dump.sql --json` |
| [`snifftable`](tools/snifftable.js) | Turn packet summaries or a CSV export into top talkers, port and protocol tables plus a conversation matrix | data, network, cli | `node tools/snifftable.js capture.txt --top 10 --matrix --json` |
| [`sortbig`](tools/sortbig.js) | External merge sort: chunk, sort, k-way merge with a min-heap; unique and dedupe | data, sort, bigdata, cli | `node tools/sortbig.js huge.log --out sorted.log --chunk 200mb` |
| [`sqlformat`](tools/sqlformat.js) | Format/beautify SQL and split multi-statement scripts without breaking string literals or comments | data, sql, cli | `node tools/sqlformat.js dump.sql --upper --indent 2 --split --json` |
| [`sqlitepeek`](tools/sqlitepeek.js) | Read-only SQLite inspector: header, page size, schema objects, row counts | data, sqlite, binary, cli | `node tools/sqlitepeek.js app.db --tables` |
| [`strings`](tools/strings.js) | Pull printable strings from binaries with ASCII/UTF-16 encodings, offsets, lengths and regex filters | data, binary, forensics, cli | `node tools/strings.js sample.bin --min 5 --utf16 --json` |
| [`targz`](tools/targz.js) | List, inspect and extract tar / tar.gz archives without shelling out to tar | data, archive, cli | `node tools/targz.js archive.tar.gz --json` |
| [`textstat`](tools/textstat.js) | Readability metrics for text: words, sentences, Flesch/Flesch-Kincaid, top words | text, analysis, nlp, cli | `node tools/textstat.js essay.txt --top 15` |
| [`tomlpeek`](tools/tomlpeek.js) | Parse TOML tables, arrays, inline tables and datetime literals to JSON with error positions | data, toml, config, cli | `node tools/tomlpeek.js Cargo.toml --json` |
| [`touchstamp`](tools/touchstamp.js) | Apply mtime/atime to many files from a CSV manifest, with dry-run and skew | files, metadata, csv, cli | `node tools/touchstamp.js manifest.csv --root ./photos --dry-run` |
| [`treejson`](tools/treejson.js) | Emit a directory tree as JSON with file sizes, per-extension and per-dir totals | files, tree, json, cli | `node tools/treejson.js ./src --depth 3 --json` |
| [`tsv2md`](tools/tsv2md.js) | Convert TSV/CSV/PSV data into GitHub-flavoured markdown tables with inferred alignment and column widths | data, markdown, cli | `node tools/tsv2md.js data.tsv --align --max-width 40 --json` |
| [`unique`](tools/unique.js) | Deduplicate lines with Levenshtein/normalized similarity, report clusters | text, dedupe, fuzzy, cli | `node tools/unique.js emails.txt --threshold 2 --keep shortest` |
| [`unitconvert`](tools/unitconvert.js) | Convert values between units across 14 categories with exact factor tables and a unit lister | data, units, cli | `node tools/unitconvert.js 100 km mi --json` |
| [`unittbl`](tools/unittbl.js) | Convert between byte units, time durations, rates and number scales in a table | units, convert, cli | `node tools/unittbl.js 1500mb --to gb --scale --json` |
| [`wavinfo`](tools/wavinfo.js) | Parse WAV/RIFF chunk inventory: audio format, rate, channels, bit depth, duration, metadata | data, audio, binary, cli | `node tools/wavinfo.js track.wav --json` |
| [`xlsx2csv`](tools/xlsx2csv.js) | Read an .xlsx workbook using a hand-rolled ZIP reader + zlib and emit CSV | data, xlsx, csv, convert, cli | `node tools/xlsx2csv.js book.xlsx --sheet 1 --out out.csv` |
| [`yamlpeek`](tools/yamlpeek.js) | Parse a practical YAML subset to JSON with line numbers in error messages | data, yaml, config, cli | `node tools/yamlpeek.js config.yaml --json` |
| [`zipmedic`](tools/zipmedic.js) | Parse a ZIP central directory, list entries/CRCs, verify and decompress members | archive, zip, cli, forensics | `node tools/zipmedic.js archive.zip --verify` |

<!-- CATALOGUE:END -->

## Adding a tool

1. Drop `tools/<name>.js` with the header block.
2. `import { args, get, num, flag, die, inputLines, table } from '../_lib.js';`
3. Help first, then parse, then work, then print.
4. `node smoke.js && node index-tools.js`.

## License

MIT — Copyright (c) 2026 0xnothings
