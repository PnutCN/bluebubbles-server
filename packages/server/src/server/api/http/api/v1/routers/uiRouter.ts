import fs from "fs";
import path from "path";
import { Next } from "koa";
import { RouterContext } from "koa-router";
import { HTML } from "../responses/success";
import { Server } from "@server";
import { FileSystem } from "@server/fileSystem";
import { isEmpty } from "@server/helpers/utils";

export class UiRouter {
    static async index(ctx: RouterContext, _: Next) {
        const landingPath = Server().repo.getConfig('landing_page_path') as string;
        if (isEmpty(landingPath)) {
            return new HTML(
                ctx,
                `
                <html>
                    <title>BlueBubbles Server</title>
                    <body>
                        <h4>Welcome to the BlueBubbles Server landing page!</h4>
                    </body>
                </html>
            `
            ).send();
        }

        // See if the file path exists
        // if it doesn't, return a warning
        // if it does, return the file
        if (fs.existsSync(landingPath)) {
            return new HTML(ctx, fs.readFileSync(landingPath, 'utf8')).send();
        }

        return new HTML(
            ctx,
            `
                <html>
                    <title>BlueBubbles Server</title>
                    <body>
                        <h4>[WARNING] Custom landing page not found!</h4>
                    </body>
                </html>
            `
        ).send();

    }

    /**
     * Serves the standalone Find My viewer (a single self-contained HTML page).
     * The page holds no data itself; it calls the guid-authenticated friends API
     * at runtime. The file lives outside the app bundle so it can be edited
     * without a rebuild. Canonical copy: packages/server/web/findmy-viewer.html.
     */
    static async findMyViewer(ctx: RouterContext, _: Next) {
        const viewerPath = path.join(FileSystem.baseDir, "findmy-viewer.html");
        if (fs.existsSync(viewerPath)) {
            return new HTML(ctx, fs.readFileSync(viewerPath, "utf8")).send();
        }

        return new HTML(
            ctx,
            `
                <html>
                    <title>Find My</title>
                    <body>
                        <h4>Find My viewer is not installed.</h4>
                        <p>Drop findmy-viewer.html into ${FileSystem.baseDir} and reload this page.</p>
                    </body>
                </html>
            `
        ).send();
    }
}
