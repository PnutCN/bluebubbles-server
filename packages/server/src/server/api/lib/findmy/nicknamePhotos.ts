import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { FileSystem } from "@server/fileSystem";
import { parsePlistBuffer } from "./decrypt/plistUtils";

// better-sqlite3 is a runtime dep; require directly for sync use here (matches localStorageReader)
const Database = require("better-sqlite3");

/**
 * Reads the shared "Name & Photo" (contact poster) images that iMessage caches under
 * ~/Library/Messages/NickNameCache. This is the photo Find My renders for a friend
 * whose Contacts card carries no local image (Contacts only keeps a ZIMAGEHASH).
 *
 * Layout (macOS 14):
 * - nicknameRecordsStore.db  kvtable["activeNicknameRecords"] — NSKeyedArchiver dict
 *   of handle -> 16-byte record id; the image lives at `<b64(rid) with / as _>-ad`
 *   next to the databases.
 * - pendingNicknamesKeyStore.db — one row per handle, an archived dict whose
 *   `ai.imageFilePath` points at the same image files. Used as fallback and for
 *   handles only present there.
 */

interface UIDRef {
    UID: number | bigint;
}

const isUid = (o: any): o is UIDRef =>
    o != null && typeof o === "object" && !Buffer.isBuffer(o) && !(o instanceof Uint8Array) && "UID" in o;

const unarchive = (archived: any): any => {
    const objects: any[] | undefined = archived?.$objects;
    if (!Array.isArray(objects)) return archived;

    const resolve = (o: any): any => {
        if (o == null || typeof o !== "object") return o;
        if (Buffer.isBuffer(o) || o instanceof Uint8Array) return Buffer.from(o);
        if (isUid(o)) return resolve(objects[Number(o.UID)]);
        if (Array.isArray(o)) return o.map(resolve);
        if (Array.isArray(o["NS.keys"]) && Array.isArray(o["NS.objects"])) {
            const out: Record<string, any> = {};
            const keys = o["NS.keys"].map((k: any) => resolve(k));
            const values = o["NS.objects"].map((v: any) => resolve(v));
            keys.forEach((k: any, i: number) => {
                out[String(k)] = values[i];
            });
            return out;
        }
        const out: Record<string, any> = {};
        for (const [k, v] of Object.entries(o)) {
            if (k === "$class") continue;
            out[k] = resolve(v);
        }
        return out;
    };

    return resolve(archived?.$top?.root);
};

const readKvtable = async (dbPath: string): Promise<Record<string, Buffer>> => {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        const out: Record<string, Buffer> = {};
        for (const row of db.prepare("SELECT key, value FROM kvtable").all()) {
            out[row.key] = row.value;
        }
        return out;
    } finally {
        db.close();
    }
};

/**
 * Builds lowercase handle -> image file path for every nickname record with an image
 * on disk. Active records win over pending ones.
 */
const sharedPhotoPaths = async (): Promise<Record<string, string>> => {
    const dir = path.join(os.homedir(), "Library", "Messages", "NickNameCache");
    const out: Record<string, string> = {};

    const pendingDb = path.join(dir, "pendingNicknamesKeyStore.db");
    if (fs.existsSync(pendingDb)) {
        try {
            const rows = await readKvtable(pendingDb);
            for (const [handle, blob] of Object.entries(rows)) {
                const rec = unarchive(await parsePlistBuffer(blob));
                const imagePath = rec?.ai?.imageFilePath;
                if (typeof imagePath === "string" && fs.existsSync(imagePath)) {
                    out[String(rec?.hid ?? handle).toLowerCase()] = imagePath;
                    out[handle.toLowerCase()] = imagePath;
                }
            }
        } catch {
            // store unreadable (locked, schema change) — fall through to active
        }
    }

    const recordsDb = path.join(dir, "nicknameRecordsStore.db");
    if (fs.existsSync(recordsDb)) {
        try {
            const rows = await readKvtable(recordsDb);
            const active = rows["activeNicknameRecords"];
            if (active) {
                const map = unarchive(await parsePlistBuffer(active));
                for (const [handle, rid] of Object.entries(map ?? {})) {
                    // rid is a 16-byte record id as a base64 string; the image file is
                    // named after it with "/" sanitized to "_"
                    const ridText = Buffer.isBuffer(rid) ? rid.toString("base64") : typeof rid === "string" ? rid : null;
                    if (!ridText) continue;
                    const imagePath = path.join(dir, `${ridText.replace(/\//g, "_")}-ad`);
                    if (fs.existsSync(imagePath)) out[handle.toLowerCase()] = imagePath;
                }
            }
        } catch {
            // fall through
        }
    }

    return out;
};

interface CachedPhoto {
    mtimeMs: number;
    data: Buffer;
}

const photoCache = new Map<string, CachedPhoto>();

const resizeIfLarge = (imagePath: string): string => {
    // Nickname photos run to 2MB+; the API is polled, so shrink anything big.
    if (fs.statSync(imagePath).size <= 256 * 1024) return imagePath;

    const outDir = path.join(FileSystem.baseDir, "FindMyAvatars");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${path.basename(imagePath)}.png`);
    execFileSync("/usr/bin/sips", ["-Z", "256", "-s", "format", "png", imagePath, "--out", outPath], { timeout: 15000 });
    return outPath;
};

/**
 * Returns the shared-photo image bytes for a handle (email exact, case-insensitive;
 * phone digit-suffix), or null. Best-effort: any failure yields null.
 */
export const readSharedPhoto = async (handle: string): Promise<Buffer | null> => {
    try {
        const photos = await sharedPhotoPaths();
        const lower = handle.toLowerCase();

        let imagePath = photos[lower];
        if (!imagePath && !lower.includes("@")) {
            const digits = lower.replace(/\D/g, "");
            if (digits.length >= 7) {
                const match = Object.entries(photos).find(([h]) => h.replace(/\D/g, "").endsWith(digits));
                imagePath = match?.[1];
            }
        }
        if (!imagePath) return null;

        const mtimeMs = fs.statSync(imagePath).mtimeMs;
        const cached = photoCache.get(imagePath);
        if (cached && cached.mtimeMs === mtimeMs) return cached.data;

        const servedPath = resizeIfLarge(imagePath);
        const data = fs.readFileSync(servedPath);
        photoCache.set(imagePath, { mtimeMs, data });
        return data;
    } catch {
        return null;
    }
};
