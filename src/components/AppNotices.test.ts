// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { LOCAL_VIEWER } from "@/lib/onboarding";

const f = vi.hoisted(() => ({
  state: { config: { onboarding: { hintsSeen: [] } }, cloudHowTo: false } as any,
  plan: null as any, phones: [] as any[], two: null as any,
  quiet: false, welcome: false, account: { status: "signed-out" } as any,
  offer: vi.fn(), consent: vi.fn(), dispatch: vi.fn(),
}));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: f.state, dispatch: f.dispatch }), api: vi.fn().mockResolvedValue({}) }));
vi.mock("@/lib/corner-popup", () => ({ cornerPopupWaits: (_s: unknown, _u: unknown, p: { quiet: boolean }) => p.quiet || f.quiet, firstChatQuiet: () => false }));
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => null }));
vi.mock("@/lib/two-places", () => ({ useTwoPlaces: () => ({ suggest: f.two, accept: vi.fn(), dismiss: vi.fn() }) }));
vi.mock("./MausBotWelcome", () => ({ useMausBotWelcomeDue: () => ({ due: f.welcome }) }));
vi.mock("./onboarding/WelcomeGate", () => ({ localDesktopPage: () => true }));
vi.mock("./PhoneUpdateNotice", () => ({
  useRetiredLinkPhones: (enabled: boolean) => enabled ? f.phones : [],
  phonesToTell: (phones: unknown) => phones,
  PhoneUpdateCard: () => "PHONE UPDATE",
}));
vi.mock("./CloudTrialNotice", () => ({
  useCloudPlanSnapshot: () => f.plan,
  CloudTrialNoticeCard: () => "BILLING NOTICE",
}));
vi.mock("./CloudNotice", () => ({
  CLOUD_NOTICE_CARD: { "sign-in-again": { dismissed: "reauth" }, removed: { dismissed: "removed" } },
  cloudNoticeStep: vi.fn(),
  CloudNoticeCard: () => "ACCOUNT NOTICE",
}));
vi.mock("./TwoPlacesCard", () => ({ TwoPlacesCard: () => "EXISTING WORKSPACE NOTICE" }));
import { AppNotices } from "./AppNotices";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear();
  f.account = { status: "signed-out" }; f.plan = { status: "none" }; f.phones = []; f.two = null; f.quiet = false; f.welcome = false;
  Object.assign(window, { ogb: {
    cloudAccount: { state: async () => f.account, onState: () => () => {}, offer: f.offer },
    cloudPlan: { noticeSeen: vi.fn().mockResolvedValue(undefined) },
    updatesConsent: { state: f.consent },
    desktopNotices: { state: async () => ({ cloud: true, seen: [] }) },
  } });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); delete (window as any).ogb; });
async function render(quiet = false) {
  await act(async () => { root.render(createElement(AppNotices, { viewer: LOCAL_VIEWER, quiet })); });
  return host.textContent;
}
it.each(["signed-out", "connected"])("never displays or fetches promotions for %s users", async status => {
  f.account = status === "connected" ? { status, entitlement: { plan: "free", status: "inactive" } } : { status };
  expect(await render()).toBe("");
  expect(f.offer).not.toHaveBeenCalled(); expect(f.consent).not.toHaveBeenCalled();
});
it("preserves phone compatibility notices", async () => {
  f.phones = [{ id: "phone-1" }];
  expect(await render()).toBe("PHONE UPDATE");
});
it("preserves existing workspace notices", async () => {
  f.two = { key: "place-1" };
  expect(await render()).toBe("EXISTING WORKSPACE NOTICE");
});
it("preserves account reauthentication notices", async () => {
  f.account = { status: "reauth-required", message: "expired", lastPlan: { tier: "pro", active: true } };
  expect(await render()).toBe("ACCOUNT NOTICE");
});
it("preserves billing notices for an existing trial", async () => {
  f.plan = { status: "paid", notice: "active", trial: { state: "active", tier: "pro", endsAt: Date.now() + 1000, chargeAt: Date.now() + 1000, amount: 4900, keep: "none", holdUntil: null, deleteAt: null } };
  expect(await render()).toBe("BILLING NOTICE");
});
it("does not interrupt a quiet page or the welcome flow", async () => {
  f.phones = [{ id: "phone-1" }];
  expect(await render(true)).toBe("");
  f.welcome = true;
  expect(await render()).toBe("");
});
