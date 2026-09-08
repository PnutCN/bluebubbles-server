import { Context, Next } from "koa";
import { Server } from "@server";
import { safeTrim } from "@server/helpers/utils";
import { ServerError } from "../responses/errors";

/**
 * Auth with anti-enumeration and brute-force banning.
 *
 * A missing/wrong password returns a plain 404 so a probed endpoint is
 * indistinguishable from one that doesn't exist. Behind the named Cloudflare
 * tunnel all external requests arrive from loopback, so the real client comes
 * from CF-Connecting-IP. 3 failures from one IP in 10 minutes bans it for an
 * hour: banned connections are dropped without any response at all. Private
 * and loopback IPs are never banned so the local UI can't lock itself out.
 */

const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const FAILURE_THRESHOLD = 3;
const BAN_MS = 60 * 60 * 1000;

const failures = new Map<string, number[]>();
const bannedUntil = new Map<string, number>();

const clientIp = (ctx: Context): string => {
    const cf = ctx.request.headers["cf-connecting-ip"];
    if (typeof cf === "string" && cf.length > 0) return cf;
    return ctx.request.ip;
};

const isPrivateIp = (ip: string): boolean =>
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "localhost" ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    ip.startsWith("169.254.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    ip.startsWith("fd") ||
    ip.startsWith("fe80");

const dropConnection = (ctx: Context) => {
    ctx.respond = false;
    ctx.req.socket.destroy();
};

const notFound = (ctx: Context) => {
    ctx.status = 404;
    ctx.body = { status: 404, message: "Not Found" };
};

export const AuthMiddleware = async (ctx: Context, next: Next) => {
    const ip = clientIp(ctx);
    const now = Date.now();

    const banEnd = bannedUntil.get(ip);
    if (banEnd != null) {
        if (banEnd > now) {
            dropConnection(ctx);
            return;
        }
        bannedUntil.delete(ip);
    }

    const params = ctx.request.query;
    const token = (params?.guid ?? params?.password ?? params?.token) as string;

    // Make sure we have a password from the database
    const password = String(Server().repo.getConfig("password") as string);
    if (!password) {
        throw new ServerError({ error: "Failed to retrieve password from the database" });
    }

    if (!token || safeTrim(password) !== safeTrim(token)) {
        Server().log(`Client (IP: ${ip}) failed API auth.`, "debug");

        if (!isPrivateIp(ip)) {
            const recent = [...(failures.get(ip) ?? []), now].filter(t => now - t < FAILURE_WINDOW_MS);
            failures.set(ip, recent);
            if (recent.length >= FAILURE_THRESHOLD) {
                bannedUntil.set(ip, now + BAN_MS);
                failures.delete(ip);
                Server().log(`Client (IP: ${ip}) banned for 1h after ${FAILURE_THRESHOLD} failed auth attempts.`, "info");
                dropConnection(ctx);
                return;
            }
        }

        notFound(ctx);
        return;
    }

    // Successful auth clears the failure count
    failures.delete(ip);
    await next();
};
