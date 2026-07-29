/*
 * core.js — pure, DOM-free logic for Fabinator WeakFrames.
 * Exposed as window.FabCore in the browser; also loadable in Node via require() for tests.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FabCore = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  // ---------------------------------------------------------------- constants
  const IMG_EXTS = ['bmp', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'webp'];
  const EXT_GROUP = '(' + IMG_EXTS.join('|') + ')';

  // 0.bmp / 0012.PNG ...
  const PLAIN_RE = new RegExp('^(\\d+)\\.' + EXT_GROUP + '$', 'i');
  // segmneted_0.bmp (the pipeline's spelling), segmented_0.bmp, and suffix forms 0_segmneted.bmp / 0-segmented.png
  const SEG_PREFIX_RE = new RegExp('^segm(?:ne|en)ted[_-](\\d+)\\.' + EXT_GROUP + '$', 'i');
  const SEG_SUFFIX_RE = new RegExp('^(\\d+)[_-]segm(?:ne|en)ted\\.' + EXT_GROUP + '$', 'i');

  const FPS_OPTIONS = [
    { label: '59.94 (60000/1001)', num: 60000, den: 1001, tag: '5994' },
    { label: '29.97 (30000/1001)', num: 30000, den: 1001, tag: '2997' },
    { label: '30', num: 30, den: 1, tag: '30' },
    { label: '60', num: 60, den: 1, tag: '60' },
    { label: '25', num: 25, den: 1, tag: '25' },
    { label: '23.976 (24000/1001)', num: 24000, den: 1001, tag: '2398' },
  ];

  const CODECS = [
    {
      id: 'prores-lt', label: 'ProRes 422 LT', tag: 'ProResLT', container: 'mov',
      encoder: 'prores_ks', mime: 'video/quicktime',
      badge: 'Default — best for most exports',
      desc: '10-bit 4:2:2, ≈100 Mbps at 1080p60. Exactly what the Fabinator pipeline expects.',
    },
    {
      id: 'prores-proxy', label: 'ProRes 422 Proxy', tag: 'ProResProxy', container: 'mov',
      encoder: 'prores_ks', mime: 'video/quicktime',
      desc: 'Same 10-bit 4:2:2 family at roughly half the bitrate — faster export, smaller file.',
    },
    {
      id: 'h264', label: 'H.264 (High Quality)', tag: 'H264HQ', container: 'mp4',
      encoder: 'libx264', mime: 'video/mp4',
      desc: 'CRF 12, High profile. Much smaller files, but 4:2:0 chroma (quarter-resolution color).',
    },
  ];

  // ---------------------------------------------------------------- filenames
  function classifyName(name) {
    let m = PLAIN_RE.exec(name);
    if (m) return { kind: 'plain', id: parseInt(m[1], 10), idRaw: m[1], ext: m[2].toLowerCase() };
    m = SEG_PREFIX_RE.exec(name) || SEG_SUFFIX_RE.exec(name);
    if (m) return { kind: 'seg', id: parseInt(m[1], 10), idRaw: m[1], ext: m[2].toLowerCase() };
    return null;
  }

  function naturalCompare(a, b) {
    const ax = String(a).toLowerCase().match(/(\d+|\D+)/g) || [];
    const bx = String(b).toLowerCase().match(/(\d+|\D+)/g) || [];
    const n = Math.max(ax.length, bx.length);
    for (let i = 0; i < n; i++) {
      const as = ax[i], bs = bx[i];
      if (as === undefined) return -1;
      if (bs === undefined) return 1;
      const an = /^\d+$/.test(as), bn = /^\d+$/.test(bs);
      if (an && bn) {
        const d = parseInt(as, 10) - parseInt(bs, 10);
        if (d) return d;
      } else if (as !== bs) {
        return as < bs ? -1 : 1;
      }
    }
    return 0;
  }

  function frameSortCompare(a, b) {
    return naturalCompare(a.relDir, b.relDir) ||
      (a.id - b.id) ||
      naturalCompare(a.name || a.plainName || '', b.name || b.plainName || '');
  }

  function sortFrames(list) { return list.slice().sort(frameSortCompare); }

  function pickSeg(cands, plainExt) {
    const same = cands.find(c => c.ext === plainExt);
    if (same) return same;
    for (const e of IMG_EXTS) {
      const hit = cands.find(c => c.ext === e);
      if (hit) return hit;
    }
    return cands[0];
  }

  /**
   * entries: [{relDir, name}] — files only; relDir '' for the root folder.
   * Pairing is per-directory, by numeric frame id, extension-agnostic.
   */
  function buildPairs(entries) {
    const byDir = new Map();
    let ignored = 0;
    for (const e of entries) {
      const c = classifyName(e.name);
      if (!c) { ignored++; continue; }
      let d = byDir.get(e.relDir);
      if (!d) { d = { plain: new Map(), seg: new Map() }; byDir.set(e.relDir, d); }
      const m = c.kind === 'plain' ? d.plain : d.seg;
      let arr = m.get(c.id);
      if (!arr) { arr = []; m.set(c.id, arr); }
      arr.push({ name: e.name, ext: c.ext, idRaw: c.idRaw });
    }

    const pairs = [], unpairedPlain = [], unpairedSeg = [], conflicts = [];
    for (const [relDir, d] of byDir) {
      const ids = new Set([...d.plain.keys(), ...d.seg.keys()]);
      for (const id of ids) {
        const P = d.plain.get(id) || [], Sg = d.seg.get(id) || [];
        if (P.length > 1) {
          // e.g. 7.bmp and 007.png in the same folder — ambiguous, refuse to pair.
          conflicts.push({ relDir, id, kind: 'duplicate-original', names: P.map(x => x.name).concat(Sg.map(x => x.name)) });
          continue;
        }
        if (P.length === 1 && Sg.length >= 1) {
          const seg = pickSeg(Sg, P[0].ext);
          if (Sg.length > 1) {
            conflicts.push({ relDir, id, kind: 'extra-segmented', names: Sg.filter(x => x !== seg).map(x => x.name) });
          }
          pairs.push({ relDir, id, plainName: P[0].name, segName: seg.name, ext: P[0].ext });
        } else if (P.length === 1) {
          unpairedPlain.push({ relDir, id, name: P[0].name, ext: P[0].ext });
        } else {
          for (const s of Sg) unpairedSeg.push({ relDir, id, name: s.name, ext: s.ext });
        }
      }
    }
    pairs.sort(frameSortCompare);
    unpairedPlain.sort(frameSortCompare);
    unpairedSeg.sort(frameSortCompare);
    conflicts.sort((a, b) => naturalCompare(a.relDir, b.relDir) || (a.id - b.id));
    return { pairs, unpairedPlain, unpairedSeg, conflicts, ignored };
  }

  function seqName(i, ext) { return 'frame_' + String(i).padStart(6, '0') + '.' + ext; }

  function sanitizeName(s) {
    return String(s).trim().replace(/[^\w.\-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'frames';
  }

  // ---------------------------------------------------------------- ffmpeg args
  function buildFFmpegArgs(opts) {
    const { codecId, fpsNum, fpsDen, ext, outName } = opts;
    const input = ['-f', 'image2', '-framerate', fpsNum + '/' + fpsDen, '-start_number', '0', '-i', '/in/frame_%06d.' + ext];
    const common = ['-fps_mode', 'passthrough'];
    let v;
    if (codecId === 'prores-lt' || codecId === 'prores-proxy') {
      v = ['-c:v', 'prores_ks', '-profile:v', codecId === 'prores-lt' ? '1' : '0', '-vendor', 'apl0',
        '-pix_fmt', 'yuv422p10le',
        '-bsf:v', 'prores_metadata=color_primaries=bt709:color_trc=bt709:colorspace=bt709'];
    } else if (codecId === 'h264') {
      v = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
        '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
        '-movflags', '+faststart'];
    } else {
      throw new Error('unknown codec: ' + codecId);
    }
    return ['-y', ...input, ...common, ...v, outName];
  }

  // ------------------------------------------------- image header dimension parsers
  function bmpSize(u8) {
    if (u8.length < 26 || u8[0] !== 0x42 || u8[1] !== 0x4D) return null;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const dibSize = dv.getUint32(14, true);
    if (dibSize === 12) {
      // BITMAPCOREHEADER (OS/2): uint16 width/height at 18/20
      const w = dv.getUint16(18, true), h = dv.getUint16(20, true);
      return (w > 0 && h > 0) ? { w, h } : null;
    }
    const w = dv.getInt32(18, true);
    const h = Math.abs(dv.getInt32(22, true)); // negative = top-down BMP
    return (w > 0 && h > 0) ? { w, h } : null;
  }

  function pngSize(u8) {
    if (u8.length < 24) return null;
    const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    for (let i = 0; i < 8; i++) if (u8[i] !== sig[i]) return null;
    // IHDR must be the first chunk
    if (u8[12] !== 0x49 || u8[13] !== 0x48 || u8[14] !== 0x44 || u8[15] !== 0x52) return null;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const w = dv.getUint32(16, false), h = dv.getUint32(20, false);
    return (w > 0 && h > 0) ? { w, h } : null;
  }

  const JPEG_SOF = new Set([0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF]);
  function jpegSize(u8) {
    if (u8.length < 4 || u8[0] !== 0xFF || u8[1] !== 0xD8) return null;
    let i = 2;
    while (i < u8.length - 1) {
      if (u8[i] !== 0xFF) { i++; continue; }
      let j = i + 1;
      while (j < u8.length && u8[j] === 0xFF) j++; // skip fill bytes
      if (j >= u8.length) break;
      const m = u8[j];
      if (m === 0x01 || (m >= 0xD0 && m <= 0xD9)) { i = j + 1; continue; } // standalone markers
      if (j + 8 >= u8.length) break;
      const len = (u8[j + 1] << 8) | u8[j + 2];
      if (len < 2) break;
      if (JPEG_SOF.has(m)) {
        const h = (u8[j + 4] << 8) | u8[j + 5];
        const w = (u8[j + 6] << 8) | u8[j + 7];
        return (w > 0 && h > 0) ? { w, h } : null;
      }
      i = j + 1 + len;
    }
    return null;
  }

  function imageSize(u8, ext) {
    ext = String(ext).toLowerCase();
    if (ext === 'bmp') return bmpSize(u8);
    if (ext === 'png') return pngSize(u8);
    if (ext === 'jpg' || ext === 'jpeg') return jpegSize(u8);
    return null; // tif/tiff/webp: skip the check
  }

  // ---------------------------------------------------------------- log parsing
  function parseFrameCount(line) {
    const m = /frame=\s*(\d+)/.exec(String(line));
    return m ? parseInt(m[1], 10) : null;
  }

  return {
    IMG_EXTS, FPS_OPTIONS, CODECS,
    classifyName, naturalCompare, sortFrames, buildPairs,
    seqName, sanitizeName, buildFFmpegArgs,
    imageSize, parseFrameCount,
  };
});
