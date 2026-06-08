import express from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import { getUiPort, PROJECT_ROOT } from "./config.js";
import { migrate } from "./db/index.js";
import { registerRoutes } from "./routes.js";
import { startJobWorker } from "./worker.js";
import { getAppBaseUrl } from "./spotifyAuth.js";

const app = express();
const root = PROJECT_ROOT;

app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(root, "public")));

registerRoutes(app);

app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: msg });
  },
);

async function main(): Promise<void> {
  await migrate();
  startJobWorker();
  const port = getUiPort();
  const host = process.env.HOST ?? "0.0.0.0";
  const server = app.listen(port, host, () => {
    console.error(`MyFM Song Matcher: ${getAppBaseUrl()}/`);
    console.error(`Listening on ${host}:${port}`);
  });
  server.setTimeout(20 * 60 * 1000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
