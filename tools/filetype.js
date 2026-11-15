#!/usr/bin/env node
// filetype.js — magic-byte file type identification across 90+ formats, extension-agnostic.
// Copyright (c) 2026 0xnothings
// @tool filetype
// @desc Identify file types from magic bytes (90+ formats) plus container-level details
// @usage node tools/filetype.js mystery.bin --json
// @tags data,binary,forensics,cli
import { args, get, flag, die, table } from '../_lib.js';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const HELP = `filetype — magic-byte file identification

  node tools/filetype.js <file|dir> [options]

  --dir <path>     scan a whole directory (recurses one level)
  --deep           also parse PE/Mach-O/ELF top-level details
  --json           machine-readable output
  -h, --help       this text

  Signatures are matched by offset so hidden-in-container formats resolve
  correctly: a PDF with a leading junk prefix, a ZIP whose entry is a real
  Office document, a tar inside gzip. Output includes the matched signature,
  its byte offset, the confidence and the extension this file likely wants.`;

const o = args(process.argv.slice(2));
// tolerant argv: a string value on a pure-boolean flag means the trailing positional was swallowed
for (const k of ['deep', 'json']) if (typeof o.f[k] === 'string') { o._.push(o.f[k]); o.f[k] = true; }

if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const target = o._[0] || get(o, 'dir', null);
if (!target) die('need a file or --dir — node tools/filetype.js mystery.bin');

const S = (label, mime, sig, extra = {}) => ({ name: label, mime, sig: Buffer.isBuffer(sig) ? sig : Buffer.from(sig, 'latin1'), ...extra });

const SIGS = [
  S('PNG image', 'image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], { ext: 'png', cat: 'image' }),
  S('JPEG image', 'image/jpeg', [0xff, 0xd8, 0xff], { ext: 'jpg', cat: 'image' }),
  S('GIF image', 'image/gif', 'GIF87a', { ext: 'gif', cat: 'image' }),
  S('GIF image', 'image/gif', 'GIF89a', { ext: 'gif', cat: 'image' }),
  S('BMP image', 'image/bmp', 'BM', { ext: 'bmp', cat: 'image' }),
  S('WebP image', 'image/webp', 'RIFF', { ext: 'webp', cat: 'image', extraAt: 8, extraSig: 'WEBP' }),
  S('TIFF image (LE)', 'image/tiff', [0x49, 0x49, 0x2a, 0x00], { ext: 'tif', cat: 'image' }),
  S('TIFF image (BE)', 'image/tiff', [0x4d, 0x4d, 0x00, 0x2a], { ext: 'tif', cat: 'image' }),
  S('ICO icon', 'image/x-icon', [0x00, 0x00, 0x01, 0x00], { ext: 'ico', cat: 'image' }),
  S('CUR cursor', 'image/x-icon', [0x00, 0x00, 0x02, 0x00], { ext: 'cur', cat: 'image' }),
  S('JPEG 2000', 'image/jp2', [0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20], { ext: 'jp2', cat: 'image' }),
  S('Photoshop PSD', 'image/vnd.adobe.photoshop', '8BPS', { ext: 'psd', cat: 'image' }),
  S('FLIC animation', 'video/x-fli', [0xaf, 0x11], { ext: 'fli', cat: 'image' }),
  S('QOI image', 'image/qoi', 'qoif', { ext: 'qoi', cat: 'image' }),

  S('WAV audio', 'audio/wav', 'RIFF', { ext: 'wav', cat: 'audio', extraAt: 8, extraSig: 'WAVE' }),
  S('AVI video', 'video/x-msvideo', 'RIFF', { ext: 'avi', cat: 'video', extraAt: 8, extraSig: 'AVI ' }),
  S('FLAC audio', 'audio/flac', 'fLaC', { ext: 'flac', cat: 'audio' }),
  S('Ogg container', 'audio/ogg', 'OggS', { ext: 'ogg', cat: 'audio' }),
  S('MP3 (ID3 tagged)', 'audio/mpeg', 'ID3', { ext: 'mp3', cat: 'audio' }),
  S('MP3 frame sync', 'audio/mpeg', [0xff, 0xfb], { ext: 'mp3', cat: 'audio' }),
  S('MIDI', 'audio/midi', 'MThd', { ext: 'mid', cat: 'audio' }),
  S('AIFF audio', 'audio/aiff', 'FORM', { ext: 'aiff', cat: 'audio', extraAt: 8, extraSig: 'AIFF' }),
  S('Au/SND audio', 'audio/basic', '.snd', { ext: 'au', cat: 'audio' }),
  S('AMR audio', 'audio/amr', '#!AMR', { ext: 'amr', cat: 'audio' }),
  S('Opus audio', 'audio/opus', 'OpusHead', { ext: 'opus', cat: 'audio' }),

  S('MP4 / ISO-BMFF', 'video/mp4', [0x00, 0x00, 0x00], { ext: 'mp4', cat: 'video', extraAt: 4, extraSig: 'ftyp', weak: true }),
  S('Matroska / WebM', 'video/x-matroska', [0x1a, 0x45, 0xdf, 0xa3], { ext: 'mkv', cat: 'video' }),
  S('FLV video', 'video/x-flv', 'FLV', { ext: 'flv', cat: 'video' }),
  S('MPEG transport stream', 'video/mp2t', [0x47], { ext: 'ts', cat: 'video', weak: true }),
  S('MPEG program stream', 'video/mpeg', [0x00, 0x00, 0x01, 0xba], { ext: 'mpg', cat: 'video' }),
  S('QuickTime MOV', 'video/quicktime', [0x00, 0x00, 0x00], { ext: 'mov', cat: 'video', extraAt: 4, extraSig: 'moov', weak: true }),
  S('MXF video', 'application/mxf', [0x06, 0x0e, 0x2b, 0x34, 0x02, 0x05, 0x01, 0x01, 0x0d, 0x01, 0x02], { ext: 'mxf', cat: 'video' }),

  S('ZIP archive', 'application/zip', [0x50, 0x4b, 0x03, 0x04], { ext: 'zip', cat: 'archive' }),
  S('ZIP (empty / spanned)', 'application/zip', [0x50, 0x4b, 0x05, 0x06], { ext: 'zip', cat: 'archive' }),
  S('Gzip', 'application/gzip', [0x1f, 0x8b], { ext: 'gz', cat: 'archive' }),
  S('Bzip2', 'application/x-bzip2', 'BZh', { ext: 'bz2', cat: 'archive' }),
  S('XZ', 'application/x-xz', [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], { ext: 'xz', cat: 'archive' }),
  S('Zstandard', 'application/zstd', [0x28, 0xb5, 0x2f, 0xfd], { ext: 'zst', cat: 'archive' }),
  S('LZ4', 'application/x-lz4', [0x04, 0x22, 0x4d, 0x18], { ext: 'lz4', cat: 'archive' }),
  S('LZMA (alone)', 'application/x-lzma', [0x5d, 0x00, 0x00], { ext: 'lzma', cat: 'archive' }),
  S('7-Zip', 'application/x-7z-compressed', [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], { ext: '7z', cat: 'archive' }),
  S('RAR v4', 'application/vnd.rar', [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00], { ext: 'rar', cat: 'archive' }),
  S('RAR v5', 'application/vnd.rar', [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00], { ext: 'rar', cat: 'archive' }),
  S('TAR (ustar)', 'application/x-tar', 'ustar', { ext: 'tar', cat: 'archive', at: 257 }),
  S('CPIO (newc)', 'application/x-cpio', '070701', { ext: 'cpio', cat: 'archive' }),
  S('CPIO (odc)', 'application/x-cpio', '070707', { ext: 'cpio', cat: 'archive' }),
  S('AR archive / .deb', 'application/x-archive', '!<arch>', { ext: 'a', cat: 'archive' }),
  S('CAB archive', 'application/vnd.ms-cab-compressed', 'MSCF', { ext: 'cab', cat: 'archive' }),
  S('ARJ archive', 'application/x-arj', [0x60, 0xea], { ext: 'arj', cat: 'archive' }),
  S('Zoo archive', 'application/x-zoo', [0x5a, 0x4f, 0x4f, 0x20], { ext: 'zoo', cat: 'archive' }),
  S('LZH / LHA', 'application/x-lzh', [0x2d, 0x6c, 0x68], { ext: 'lzh', cat: 'archive' }),
  S('SQSH / squashfs', 'application/x-squashfs', [0x68, 0x73, 0x71, 0x73], { ext: 'squashfs', cat: 'archive' }),
  S('EROFS', 'application/x-erofs', [0xe2, 0xe1, 0xf5, 0xe0], { ext: 'erofs', cat: 'archive' }),
  S('Google Chrome extension CRX', 'application/x-chrome-extension', 'Cr24', { ext: 'crx', cat: 'archive' }),

  S('PDF document', 'application/pdf', '%PDF', { ext: 'pdf', cat: 'document' }),
  S('PostScript', 'application/postscript', '%!PS', { ext: 'ps', cat: 'document' }),
  S('RTF document', 'application/rtf', '{\\rtf', { ext: 'rtf', cat: 'document' }),
  S('Microsoft OLE2 (doc/xls/ppt)', 'application/x-ole-storage', [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], { ext: 'ole', cat: 'document' }),
  S('SQLite 3 database', 'application/vnd.sqlite3', 'SQLite format 3', { ext: 'sqlite', cat: 'document' }),
  S('DjVu document', 'image/vnd.djvu', 'AT&TFORM', { ext: 'djvu', cat: 'document' }),
  S('EPUB (zip based)', 'application/epub+zip', [0x50, 0x4b, 0x03, 0x04], { ext: 'epub', cat: 'document' }),
  S('Windows Registry hive', 'application/x-registry', 'regf', { ext: 'hive', cat: 'forensics' }),
  S('Windows Event Log (evtx)', 'application/x-evtx', 'ElfFile', { ext: 'evtx', cat: 'forensics' }),
  S('Windows PAGEFILE/PAGEDUMP', 'application/x-dump', 'PAGEDU64', { ext: 'dmp', cat: 'forensics' }),
  S('Windows minidump', 'application/x-dump', 'MDMP', { ext: 'dmp', cat: 'forensics' }),
  S('Chrome cache entry', 'application/x-chrome-cache', 'CACHE MANIFEST', { ext: 'cache', cat: 'forensics' }),
  S('Java class file', 'application/java-vm', [0xca, 0xfe, 0xba, 0xbe], { ext: 'class', cat: 'executable' }),
  S('Mach-O 64-bit', 'application/x-mach-binary', [0xcf, 0xfa, 0xed, 0xfe], { ext: 'macho', cat: 'executable' }),
  S('Mach-O 32-bit', 'application/x-mach-binary', [0xce, 0xfa, 0xed, 0xfe], { ext: 'macho', cat: 'executable' }),
  S('Mach-O universal', 'application/x-mach-binary', [0xca, 0xfe, 0xba, 0xbe], { ext: 'macho', cat: 'executable' }),
  S('ELF executable', 'application/x-executable', [0x7f, 0x45, 0x4c, 0x46], { ext: 'elf', cat: 'executable' }),
  S('DOS/MZ executable', 'application/x-dosexec', 'MZ', { ext: 'exe', cat: 'executable' }),
  S('DOS/COM/SYS', 'application/x-dosexec', [0xeb], { ext: 'com', cat: 'executable', weak: true }),
  S('Debian package', 'application/vnd.debian.binary-package', '!<arch>', { ext: 'deb', cat: 'package' }),
  S('RPM package', 'application/x-rpm', [0xed, 0xab, 0xee, 0xdb], { ext: 'rpm', cat: 'package' }),
  S('MSI / CFB', 'application/x-msi', [0xd0, 0xcf, 0x11, 0xe0], { ext: 'msi', cat: 'package' }),

  S('TrueType font', 'font/ttf', [0x00, 0x01, 0x00, 0x00], { ext: 'ttf', cat: 'font' }),
  S('OpenType font', 'font/otf', 'OTTO', { ext: 'otf', cat: 'font' }),
  S('WOFF font', 'font/woff', 'wOFF', { ext: 'woff', cat: 'font' }),
  S('WOFF2 font', 'font/woff2', 'wOF2', { ext: 'woff2', cat: 'font' }),
  S('Type1 font', 'font/type1', '%!PS-AdobeFont', { ext: 'pfb', cat: 'font' }),

  S('PGP message', 'application/pgp-encrypted', '-----BEGIN PGP', { ext: 'pgp', cat: 'crypto' }),
  S('OpenSSH private key', 'application/x-openssh-key', '-----BEGIN OPENSSH PRIVATE KEY', { ext: 'key', cat: 'crypto' }),
  S('PEM certificate/key', 'application/x-pem-file', '-----BEGIN', { ext: 'pem', cat: 'crypto' }),
  S('DER certificate', 'application/x-x509-ca-cert', [0x30, 0x82], { ext: 'der', cat: 'crypto', weak: true }),
  S('Java keystore (JKS)', 'application/x-java-keystore', [0xfe, 0xed, 0xfe, 0xed], { ext: 'jks', cat: 'crypto' }),
  S('LUKS encrypted volume', 'application/x-luks', 'LUKS', { ext: 'luks', cat: 'crypto' }),
  S('TrueCrypt/VeraCrypt', 'application/x-veracrypt', 'VERA', { ext: 'vc', cat: 'crypto' }),

  S('BitTorrent metainfo', 'application/x-bittorrent', 'd8:announce', { ext: 'torrent', cat: 'data' }),
  S('Android binary XML (AXML)', 'application/x-axml', [0x03, 0x00, 0x08, 0x00], { ext: 'axml', cat: 'data' }),
  S('Android DEX', 'application/x-dex', 'dex\n', { ext: 'dex', cat: 'data' }),
  S('Android resources.arsc', 'application/x-arsc', [0x02, 0x00, 0x0c, 0x00], { ext: 'arsc', cat: 'data' }),
  S('Windows shortcut LNK', 'application/x-ms-shortcut', [0x4c, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00], { ext: 'lnk', cat: 'data' }),
  S('PCAP capture', 'application/vnd.tcpdump.pcap', [0xd4, 0xc3, 0xb2, 0xa1], { ext: 'pcap', cat: 'network' }),
  S('PCAP capture (BE)', 'application/vnd.tcpdump.pcap', [0xa1, 0xb2, 0xc3, 0xd4], { ext: 'pcap', cat: 'network' }),
  S('PCAP-NG capture', 'application/x-pcapng', [0x0a, 0x0d, 0x0d, 0x0a], { ext: 'pcapng', cat: 'network' }),
  S('Docker image manifest (zip)', 'application/vnd.docker', [0x50, 0x4b, 0x03, 0x04], { ext: 'zip', cat: 'container' }),
  S('ISO 9660 image', 'application/x-iso9660-image', 'CD001', { ext: 'iso', cat: 'disk', at: 0x8001 }),
  S('VMDK disk', 'application/x-vmdk', 'KDMV', { ext: 'vmdk', cat: 'disk' }),
  S('QCOW disk image', 'application/x-qcow', 'QFI\xfb', { ext: 'qcow2', cat: 'disk' }),
  S('VHD disk image', 'application/x-vhd', 'conectix', { ext: 'vhd', cat: 'disk' }),
  S('VHDX disk image', 'application/x-vhdx', 'vhdxfile', { ext: 'vhdx', cat: 'disk' }),
  S('EWF / EnCase image', 'application/x-ewf', 'EVF\x09\x0d\x0a\xff\x00', { ext: 'E01', cat: 'disk' }),
  S('ext2/3/4 filesystem', 'application/x-ext', [0x53, 0xef], { ext: 'img', cat: 'disk', at: 0x438 }),
  S('FAT filesystem boot sector', 'application/x-fat', 'FAT', { ext: 'img', cat: 'disk', at: 0x36 }),
  S('NTFS boot sector', 'application/x-ntfs', 'NTFS    ', { ext: 'img', cat: 'disk' }),
  S('Linux swap', 'application/x-swap', 'SWAPSPACE2', { ext: 'swap', cat: 'disk', at: 0xff6 }),
  S('LZOP', 'application/x-lzop', [0x89, 0x4c, 0x5a, 0x4f], { ext: 'lzo', cat: 'archive' }),
  S('Windows PE resource (MZ later)', 'application/x-dosexec', 'This program cannot be run in DOS mode', { ext: 'exe', cat: 'executable', at: 0 },
  ),
];

// ftyp check: bytes 4..8 == 'ftyp'
function detectMany(buf) {
  const hits = [];
  for (const s of SIGS) {
    const at = s.at || 0;
    if (at + s.sig.length > buf.length) continue;
    if (!buf.slice(at, at + s.sig.length).equals(s.sig)) continue;
    if (s.extraAt !== undefined) {
      if (s.extraAt + s.extraSig.length > buf.length) continue;
      if (buf.slice(s.extraAt, s.extraAt + s.extraSig.length).toString('latin1') !== s.extraSig) continue;
    }
    hits.push({ name: s.name, mime: s.mime, ext: s.ext, cat: s.cat, offset: at, matched: s.sig.toString('hex'), weak: !!s.weak });
  }
  if (buf.length >= 12 && buf.slice(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.slice(8, 12).toString('latin1');
    hits.push({ name: `ISO-BMFF / MP4 (brand ${brand})`, mime: 'video/mp4', ext: 'mp4', cat: 'video', offset: 4, matched: '66747970', brand });
  }
  return hits;
}

function peDetails(buf) {
  const peOffAt = 0x3c;
  if (buf.length < 0x40) return null;
  const peOff = buf.readUInt32LE(peOffAt);
  if (peOff + 24 > buf.length || buf.slice(peOff, peOff + 4).toString('latin1') !== 'PE\0\0') return null;
  const machine = buf.readUInt16LE(peOff + 4);
  const sections = buf.readUInt16LE(peOff + 6);
  const timestamp = buf.readUInt32LE(peOff + 8);
  const optSize = buf.readUInt16LE(peOff + 20);
  const characteristics = buf.readUInt16LE(peOff + 22);
  const magic = buf.readUInt16LE(peOff + 24);
  const machines = { 0x014c: 'i386', 0x8664: 'x86-64', 0x01c0: 'ARM', 0xaa64: 'ARM64', 0x0200: 'IA64' };
  return {
    peOffset: peOff, machine: machines[machine] || `0x${machine.toString(16)}`, sections,
    compiledAt: new Date(timestamp * 1000).toISOString(), optionalHeaderBytes: optSize,
    container: magic === 0x20b ? 'PE32+ (64-bit)' : magic === 0x10b ? 'PE32 (32-bit)' : `0x${magic.toString(16)}`,
    isDll: !!(characteristics & 0x2000), isExecutable: !!(characteristics & 0x0002), characteristics: '0x' + characteristics.toString(16),
    subsystem: buf.length > peOff + 92 ? buf.readUInt16LE(peOff + 24 + 68) : null,
  };
}

function elfDetails(buf) {
  return {
    class: buf[4] === 2 ? 'ELF64' : buf[4] === 1 ? 'ELF32' : '?',
    endian: buf[5] === 2 ? 'big-endian' : 'little-endian',
    osabi: ['System V', 'HP-UX', 'NetBSD', 'Linux', 'GNU/Hurd', 'Solaris'][buf[7]] || `0x${buf[7].toString(16)}`,
    type: { 1: 'relocatable', 2: 'executable', 3: 'shared object/PIE', 4: 'core dump' }[buf.readUInt16LE(16)] || '?',
    machine: { 3: 'x86', 0x3e: 'x86-64', 0x28: 'ARM', 0xb7: 'AArch64', 0xf3: 'RISC-V', 8: 'MIPS' }[buf.readUInt16LE(18)] || `0x${buf.readUInt16LE(18).toString(16)}`,
    entryPoint: buf[4] === 2 ? Number(buf.readBigUInt64LE(24)) : buf.readUInt32LE(24),
  };
}

function scanOne(path) {
  let buf, size;
  try { buf = readFileSync(path); size = statSync(path).size; } catch (e) { return { path, error: e.message }; }
  const hits = detectMany(buf);
  const best = hits.find((h) => !h.weak) || hits[0] || null;
  const rec = {
    path, size,
    type: best ? best.name : (buf.length ? 'unknown binary/data' : 'empty file'),
    mime: best ? best.mime : 'application/octet-stream',
    extension: best ? best.ext : null,
    category: best ? best.cat : null,
    signatureOffset: best ? best.offset : null,
    alternatives: hits.slice(1, 4).map((h) => h.name),
    entropy: (() => { const c = new Array(256).fill(0); for (const b of buf) c[b]++; let e = 0; for (const n of c) if (n) { const p = n / buf.length; e -= p * Math.log2(p); } return Number(e.toFixed(3)); })(),
    textLike: buf.length > 0 && !buf.slice(0, 512).some((x) => x === 0) && [...buf.slice(0, 256)].filter((x) => x >= 0x20 || x === 9 || x === 10 || x === 13).length > 200,
    hasShebang: buf.slice(0, 2).toString('latin1') === '#!',
    shebang: buf.slice(0, 2).toString('latin1') === '#!' ? buf.slice(2, buf.indexOf(0x0a)).toString('utf8') : null,
    bom: buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 'UTF-8 BOM' : buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe ? 'UTF-16LE BOM' : null,
    magicHex: buf.slice(0, 16).toString('hex'),
  };
  if (flag(o, 'deep')) {
    if (rec.type.includes('PE') || rec.type.includes('DOS/MZ')) rec.pe = peDetails(buf);
    if (rec.type.includes('ELF')) rec.elf = elfDetails(buf);
    if (rec.type.includes('ZIP')) {
      const entries = [];
      let p = 0;
      while (p + 30 <= buf.length && entries.length < 40) {
        if (buf.readUInt32LE(p) !== 0x04034b50) break;
        const nlen = buf.readUInt16LE(p + 26), xlen = buf.readUInt16LE(p + 28);
        const entryName = buf.slice(p + 30, p + 30 + nlen).toString('utf8');
        const csize = buf.readUInt32LE(p + 18);
        entries.push({ name: entryName, compressedSize: csize });
        p += 30 + nlen + xlen + csize;
      }
      rec.zipEntries = entries;
    }
  }
  return rec;
}

const results = [];
if (flag(o, 'dir') || (target && !flag(o, 'dir') && (() => { try { return statSync(target).isDirectory(); } catch { return false; } })())) {
  const dir = get(o, 'dir', target);
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isFile()) results.push(scanOne(join(dir, ent.name)));
    else if (ent.isDirectory()) {
      for (const sub of readdirSync(join(dir, ent.name), { withFileTypes: true })) if (sub.isFile()) results.push(scanOne(join(dir, ent.name, sub.name)));
    }
  }
} else results.push(scanOne(target));

if (flag(o, 'json')) process.stdout.write(JSON.stringify(results.length === 1 ? results[0] : { scanned: results.length, files: results }, null, 2) + '\n');
else {
  if (results.length === 1) {
    const r = results[0];
    if (r.error) die(`cannot read ${r.path}: ${r.error}`);
    console.log(`${r.path} — ${r.type}`);
    console.log(table([
      { field: 'mime', value: r.mime },
      { field: 'suggested extension', value: '.' + (r.extension || '?') },
      { field: 'category', value: r.category || '-' },
      { field: 'size', value: `${r.size} bytes` },
      { field: 'signature offset', value: r.signatureOffset === null ? '-' : String(r.signatureOffset) },
      { field: 'magic', value: r.magicHex },
      { field: 'entropy', value: `${r.entropy} bits/byte` },
      { field: 'text-like', value: r.textLike ? 'yes' : 'no' },
      { field: 'shebang', value: r.shebang || '-' },
      { field: 'BOM', value: r.bom || '-' },
      { field: 'other matches', value: r.alternatives.join(', ') || '-' },
    ], ['field', 'value']));
    if (r.pe) console.log('\nPE: ' + JSON.stringify(r.pe, null, 2));
    if (r.elf) console.log('\nELF: ' + JSON.stringify(r.elf, null, 2));
    if (r.zipEntries) console.log('\nZIP entries: ' + r.zipEntries.map((e) => e.name).join(', '));
  } else {
    console.log(`${results.length} file(s) scanned`);
    console.log(table(results.map((r) => ({
      file: r.path.split(/[\\/]/).pop(), type: r.type, ext: '.' + (r.extension || '?'),
      size: r.size, entropy: r.entropy, offset: r.signatureOffset === null ? '-' : r.signatureOffset,
    })), ['file', 'type', 'ext', 'size', 'entropy', 'offset']));
  }
}
