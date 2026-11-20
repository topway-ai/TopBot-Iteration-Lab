import { PASS, type RouteHandler } from "./table.ts";

export const ANNOUNCEMENTS_PATH = "/api/announcements";

/** GET /api/announcements retains the client contract without downloading promotional content. */
export const announcementRoutes: RouteHandler = async ({ res, path, method, json }) => {
  if (path !== ANNOUNCEMENTS_PATH) return PASS;
  if (method !== "GET") return json(res, 405, { error: "Use GET." });
  return json(res, 200, { cards: [], disabled: true });
};
