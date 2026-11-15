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

**30 tools**

| Tool | Description | Tags | Usage |
|---|---|---|---|
| [`baseconv`](tools/baseconv.js) | Convert integers between bases 2-36 with BigInt precision and bit utilities | numbers, convert, cli | `node tools/baseconv.js "deadbeef" --from 16 --to 2` |
| [`csvdiff`](tools/csvdiff.js) | Key-based CSV diff reporting added, removed and changed rows field by field | data, csv, diff, cli | `node tools/csvdiff.js old.csv new.csv --key id` |
| [`csvfix`](tools/csvfix.js) | Repair malformed CSV: strip BOM, fix quote imbalance, normalize delimiters and widths | data, csv, repair, cli | `node tools/csvfix.js broken.csv --report` |
| [`csvjoin`](tools/csvjoin.js) | Inner/left/right/full join of two CSVs on a key column with unmatched counts | data, csv, cli | `node tools/csvjoin.js left.csv right.csv --on id --how left` |
| [`csvjson`](tools/csvjson.js) | Convert between CSV and JSON in either direction with RFC4180 quoting | data, csv, json, convert, cli | `node tools/csvjson.js data.csv --to json --typed` |
| [`csvpeek`](tools/csvpeek.js) | Sniff delimiter, headers, column types, uniqueness and a sample from a CSV/TSV file | data, csv, cli | `node tools/csvpeek.js data.csv --rows 5` |
| [`csvsample`](tools/csvsample.js) | Single-pass reservoir/head/systematic sampling of a huge CSV with O(1) memory | data, csv, sampling, cli | `node tools/csvsample.js huge.csv --n 100 --seed 42 --json` |
| [`csvsql`](tools/csvsql.js) | Query a CSV file with a SQL subset: SELECT cols WHERE cond ORDER BY LIMIT | data, csv, sql, cli | `node tools/csvsql.js data.csv "SELECT name, age WHERE age > 30 ORDER BY age DESC LIMIT 5"` |
| [`datecalc`](tools/datecalc.js) | Date arithmetic: shift dates, diff two dates, business-day math, ISO week | time, date, cli | `node tools/datecalc.js 2026-03-01 --add 45d --workdays` |
| [`dupefind`](tools/dupefind.js) | Find duplicate files by size-then-hash, report reclaimable bytes and clusters | files, dedupe, disk, cli | `node tools/dupefind.js ./photos --min-size 1kb` |
| [`exifread`](tools/exifread.js) | Parse JPEG EXIF: camera, exposure, orientation, timestamps, GPS coordinates | media, images, exif, metadata, cli | `node tools/exifread.js photo.jpg --json` |
| [`freqcount`](tools/freqcount.js) | Word/line/n-gram frequency counts with stopwords, stemming-lite and TF tables | text, analysis, frequency, cli | `node tools/freqcount.js book.txt --mode words --top 25` |
| [`hashdir`](tools/hashdir.js) | Hash a directory tree into a manifest and verify it later, detecting drift | files, hashing, integrity, cli | `node tools/hashdir.js ./src --algo sha256 --out manifest.json` |
| [`imgdim`](tools/imgdim.js) | Read width/height/format from PNG, JPEG, GIF, WebP, BMP and TIFF headers | media, images, metadata, cli | `node tools/imgdim.js photo.jpg logo.png --json` |
| [`jsondiff`](tools/jsondiff.js) | Structural JSON diff with JSON-pointer paths, type changes and array diffing | data, json, diff, cli | `node tools/jsondiff.js a.json b.json --json` |
| [`jsongrid`](tools/jsongrid.js) | Flatten a nested JSON array/object into an aligned table with discovered columns | data, json, table, cli | `node tools/jsongrid.js data.json --depth 3 --json` |
| [`jsoninfer`](tools/jsoninfer.js) | Infer a JSON Schema (draft-style) from sample data, merging arrays of objects | data, json, schema, cli | `node tools/jsoninfer.js api-dump.json --required` |
| [`jsonlines`](tools/jsonlines.js) | Convert between NDJSON and JSON arrays, filter with predicates, sample rows | data, json, ndjson, cli | `node tools/jsonlines.js events.ndjson --to array --grep error` |
| [`jsonpath`](tools/jsonpath.js) | Query JSON with a JSONPath subset ($ .key [n] [*] ..key) and set values in place | data, json, query, cli | `node tools/jsonpath.js data.json '$.items[*].name' --json` |
| [`logtail`](tools/logtail.js) | Tail a log file with grep/level filters, follow simulation, JSON and histogram | logs, text, cli | `node tools/logtail.js app.log --lines 100 --grep ERROR --json` |
| [`renamebatch`](tools/renamebatch.js) | Regex bulk renamer with dry-run preview, collision detection and undo script | files, rename, batch, cli | `node tools/renamebatch.js ./shots --find 'IMG_(\\d+)' --replace 'photo-$1' --dry-run` |
| [`sortbig`](tools/sortbig.js) | External merge sort: chunk, sort, k-way merge with a min-heap; unique and dedupe | data, sort, bigdata, cli | `node tools/sortbig.js huge.log --out sorted.log --chunk 200mb` |
| [`sqlitepeek`](tools/sqlitepeek.js) | Read-only SQLite inspector: header, page size, schema objects, row counts | data, sqlite, binary, cli | `node tools/sqlitepeek.js app.db --tables` |
| [`textstat`](tools/textstat.js) | Readability metrics for text: words, sentences, Flesch/Flesch-Kincaid, top words | text, analysis, nlp, cli | `node tools/textstat.js essay.txt --top 15` |
| [`touchstamp`](tools/touchstamp.js) | Apply mtime/atime to many files from a CSV manifest, with dry-run and skew | files, metadata, csv, cli | `node tools/touchstamp.js manifest.csv --root ./photos --dry-run` |
| [`treejson`](tools/treejson.js) | Emit a directory tree as JSON with file sizes, per-extension and per-dir totals | files, tree, json, cli | `node tools/treejson.js ./src --depth 3 --json` |
| [`unique`](tools/unique.js) | Deduplicate lines with Levenshtein/normalized similarity, report clusters | text, dedupe, fuzzy, cli | `node tools/unique.js emails.txt --threshold 2 --keep shortest` |
| [`unittbl`](tools/unittbl.js) | Convert between byte units, time durations, rates and number scales in a table | units, convert, cli | `node tools/unittbl.js 1500mb --to gb --scale --json` |
| [`xlsx2csv`](tools/xlsx2csv.js) | Read an .xlsx workbook using a hand-rolled ZIP reader + zlib and emit CSV | data, xlsx, csv, convert, cli | `node tools/xlsx2csv.js book.xlsx --sheet 1 --out out.csv` |
| [`zipmedic`](tools/zipmedic.js) | Parse a ZIP central directory, list entries/CRCs, verify and decompress members | archive, zip, cli, forensics | `node tools/zipmedic.js archive.zip --verify` |

<!-- CATALOGUE:END -->

## Adding a tool

1. Drop `tools/<name>.js` with the header block.
2. `import { args, get, num, flag, die, inputLines, table } from '../_lib.js';`
3. Help first, then parse, then work, then print.
4. `node smoke.js && node index-tools.js`.

## License

MIT — Copyright (c) 2026 0xnothings
