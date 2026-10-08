import fs from "node:fs";
import path from "node:path";
import { log, type FolderWatch, type Paths } from "./config";

/**
 * Watching the folders the clinic's software saves into.
 *
 * Polled, not `fs.watch`: the folder is often on another computer (a network
 * share the x-ray PC saves to), where change notifications are unreliable,
 * and a look every three seconds costs nothing. A file is sent once it has
 * been the same size on two looks in a row — imaging software writes large
 * files in pieces, and half an x-ray is no use to anybody.
 *
 * What was in a folder when it was added is the past and is left alone. What
 * arrives while the Bridge is not running (the computer was off) is still
 * new when it starts again: each file sent is remembered, so nothing goes
 * twice and nothing is skipped.
 */

/** Pictures, DICOM, and the other things machines make: scans, reports, video. */
const KNOWN = /\.(jpe?g|png|bmp|gif|webp|tiff?|dcm|dicom|pdf|stl|ply|obj|mp4)$/i;
/** DICOM exports are often named IM0001 or 1.2.840…, with no extension. */
const BARE = /^[^.]+$|^[\d.]+$/;
const SKIP = /^(~\$|\.)|\.(tmp|part|partial|crdownload|lock|db|ini|lnk)$|^thumbs\.db$|^desktop\.ini$/i;
const DEPTH = 3;
/** Files modified longer ago than this, never seen, are old archive — not sent. */
const NEW_FOR_MS = 7 * 24 * 3600_000;

export type FolderState = { path: string; ok: boolean; error?: string; lastFile?: { name: string; at: number } };

export class FolderWatcher {
  private seen = new Map<string, number>();
  private growing = new Map<string, number>();
  states: FolderState[] = [];

  constructor(
    private p: Paths,
    private folders: () => FolderWatch[],
    private onFile: (file: string, name: string, data: Buffer) => void,
    private onChange: () => void
  ) {
    try {
      const saved = JSON.parse(fs.readFileSync(p.seen, "utf8")) as Record<string, number>;
      for (const [k, v] of Object.entries(saved)) this.seen.set(k, v);
    } catch {
      // first run
    }
  }

  private persist() {
    // A month of memory is plenty: older files are never new again anyway.
    const cutoff = Date.now() - 31 * 24 * 3600_000;
    for (const [k, v] of this.seen) if (v < cutoff) this.seen.delete(k);
    fs.writeFileSync(this.p.seen, JSON.stringify(Object.fromEntries(this.seen)));
  }

  private *walk(dir: string, depth = 0): Generator<string> {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP.test(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < DEPTH) yield* this.walk(full, depth + 1);
      } else if (e.isFile() && (KNOWN.test(e.name) || BARE.test(e.name))) {
        yield full;
      }
    }
  }

  /** Everything there now counts as already handled — used when a folder is first added. */
  baseline(folder: string) {
    for (const f of this.walk(folder)) {
      try {
        const st = fs.statSync(f);
        this.seen.set(`${f}|${st.size}|${st.mtimeMs}`, Date.now());
      } catch {
        // vanished
      }
    }
    this.persist();
  }

  look() {
    let changed = false;
    const states: FolderState[] = [];
    for (const w of this.folders()) {
      const state: FolderState = { path: w.path, ok: true, lastFile: this.states.find((s) => s.path === w.path)?.lastFile };
      if (!fs.existsSync(w.path)) {
        state.ok = false;
        state.error = "folder_missing";
        states.push(state);
        continue;
      }
      for (const f of this.walk(w.path)) {
        let st: fs.Stats;
        try {
          st = fs.statSync(f);
        } catch {
          continue;
        }
        const id = `${f}|${st.size}|${st.mtimeMs}`;
        if (this.seen.has(id) || st.size === 0) continue;
        /*
          Old, and never seen: archive that was there before, not a new
          picture. "Arrived" is the later of written and created — a copy
          keeps the original's modified date, but on Windows its creation
          date is the moment it was copied in.
        */
        const arrived = Math.max(st.mtimeMs, st.birthtimeMs || 0);
        if (arrived < Math.max(w.added, Date.now() - NEW_FOR_MS) - 60_000) {
          this.seen.set(id, Date.now());
          changed = true;
          continue;
        }
        const before = this.growing.get(f);
        if (before !== st.size) {
          this.growing.set(f, st.size);
          continue;
        }
        this.growing.delete(f);
        let data: Buffer;
        try {
          data = fs.readFileSync(f);
        } catch (e) {
          // Still locked by the program writing it: next look.
          log("cannot read yet", f, e);
          continue;
        }
        if (!KNOWN.test(f) && !(data.length > 132 && data.toString("latin1", 128, 132) === "DICM")) {
          // An extensionless file that is not DICOM is not an image.
          this.seen.set(id, Date.now());
          changed = true;
          continue;
        }
        this.onFile(f, path.basename(f), data);
        this.seen.set(id, Date.now());
        state.lastFile = { name: path.basename(f), at: Date.now() };
        changed = true;
      }
      states.push(state);
    }
    const before = JSON.stringify(this.states);
    this.states = states;
    if (changed) this.persist();
    if (changed || before !== JSON.stringify(states)) this.onChange();
  }
}
