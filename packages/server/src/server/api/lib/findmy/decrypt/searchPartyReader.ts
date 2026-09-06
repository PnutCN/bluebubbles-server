import fs from "fs";
import path from "path";
import crypto from "crypto";
import { FileSystem } from "@server/fileSystem";
import { parsePlistBuffer } from "./plistUtils";
import { RawFriendLocation, stripPadding } from "./localStorageReader";

/**
 * Decrypts a single searchpartyd `.record` file.
 *
 * The record is a binary plist array of `[nonce, tag, ciphertext]`, encrypted with
 * AES-256-GCM under the store-wide SearchParty master key (no AAD). The plaintext is
 * another binary plist. The GCM tag doubles as a correctness check — a wrong key
 * throws in `final()`, which we treat as an unreadable record.
 */
export const decryptSearchPartyRecord = async (filePath: string, key: Buffer): Promise<any | null> => {
    try {
        const wrapper = await parsePlistBuffer(fs.readFileSync(filePath));
        if (!Array.isArray(wrapper) || wrapper.length !== 3) return null;

        const [nonce, tag, ciphertext] = wrapper.map(b => (Buffer.isBuffer(b) ? b : Buffer.from(b)));
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return await parsePlistBuffer(plaintext);
    } catch {
        return null;
    }
};

/** Extracts "email@x.com" / "+1555..." from an ownerHandle destination ("token:.../mailto:x"). */
const parseOwnerHandle = (destination: any): string | null => {
    if (typeof destination !== "string" || destination.length === 0) return null;
    const last = destination.split("/").pop() ?? "";
    const schemeIdx = last.indexOf(":");
    const handle = schemeIdx >= 0 ? last.slice(schemeIdx + 1) : last;
    return handle.length > 0 ? handle : null;
};

const recordFiles = (dir: string): string[] => {
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter(f => f.endsWith(".record"))
        .map(f => path.join(dir, f));
};

/**
 * Reads friend coordinates from the searchpartyd secure-location store.
 *
 * Some macOS 14.4+ builds no longer keep friend coordinates in LocalStorage.db's
 * `secureLocations` table; searchpartyd holds them instead:
 *
 * - `SecureLocationCache/*.record` — one per friend, `{ secureLocation: { latitude,
 *   longitude, timestamp, findMyId, ... } }`, refreshed as friends move.
 * - `SecureLocationSharedKeys/*.record` — per-friend key material plus
 *   `ownerHandle.destination` (email/phone), used to resolve the handle.
 *
 * Everything is encrypted under one store-wide AES-256-GCM master key.
 */
export const readSearchPartyFriendLocations = async (key: Buffer): Promise<RawFriendLocation[]> => {
    const base = FileSystem.searchPartyDir;

    // findMyId -> handle from the shared-keys records
    const handleById: Record<string, string> = {};
    for (const file of recordFiles(path.join(base, "SecureLocationSharedKeys"))) {
        const rec = await decryptSearchPartyRecord(file, key);
        const fid = stripPadding(String(rec?.findMyId ?? ""));
        const handle = parseOwnerHandle(rec?.ownerHandle?.destination);
        if (fid && handle) handleById[fid] = handle;
    }

    const out: RawFriendLocation[] = [];
    for (const file of recordFiles(path.join(base, "SecureLocationCache"))) {
        const rec = await decryptSearchPartyRecord(file, key);
        const location = rec?.secureLocation;
        if (!location || typeof location !== "object") continue;

        const fid = stripPadding(String(location.findMyId ?? rec?.findMyId ?? ""));
        if (!fid) continue;

        out.push({
            findMyId: fid,
            handle: handleById[fid] ?? null,
            location
        });
    }

    return out;
};
