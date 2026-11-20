import { useEffect, useState } from "react";
import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import { api, useStore } from "@/state/store";
import { cloudNoticeKind, cloudPlanView, cloudTrialNotice, cloudTrialView } from "@/lib/cloud-plan";
import { cornerPopupWaits, firstChatQuiet } from "@/lib/corner-popup";
import { CLOUD_NOTICE, CLOUD_TRIAL_NOTICE, dismissNotice, dismissNotices, launchNotice, markLaunchNotice, nextNotice, NOTICES, noticeSeen, PHONE_UPDATE_NOTICE, phoneUpdateHint, TWO_PLACES_NOTICE, type NoticeFacts } from "@/lib/notices";
import { useTwoPlaces } from "@/lib/two-places";
import type { WelcomeViewer } from "@/lib/onboarding";
import { useUpdaterState } from "@/lib/updater";
import { phonePairingSettingsAction } from "@/lib/phone-pairing";
import { CLOUD_NOTICE_CARD, cloudNoticeStep, CloudNoticeCard } from "./CloudNotice";
import { CloudTrialNoticeCard, useCloudPlanSnapshot } from "./CloudTrialNotice";
import { localDesktopPage } from "./onboarding/WelcomeGate";
import { useMausBotWelcomeDue } from "./MausBotWelcome";
import { PhoneUpdateCard, phonesToTell, useRetiredLinkPhones } from "./PhoneUpdateNotice";
import { TwoPlacesCard } from "./TwoPlacesCard";

export function AppNotices({ quiet = false, viewer = null }: { quiet?: boolean; viewer?: WelcomeViewer | null; now?: () => number }) {
  const { state, dispatch } = useStore();
  const remote = window.ogb?.remoteClient?.active === true;
  const local = localDesktopPage();
  const bridge = !remote && local ? window.ogb?.cloudAccount : undefined;
  const planBridge = !remote && (bridge || viewer?.cloudHome) ? window.ogb?.cloudPlan : undefined;
  const [account, setAccount] = useState<CloudAccountState | null>(null);
  const [closed, setClosed] = useState(false);
  const [trialOpen, setTrialOpen] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const plan = useCloudPlanSnapshot(planBridge);
  const updater = useUpdaterState();
  const welcome = useMausBotWelcomeDue(viewer);
  const two = useTwoPlaces();
  const linkPhones = useRetiredLinkPhones(!remote && local);
  useEffect(() => {
    if (!bridge) return;
    let active = true, updated = false;
    const unsubscribe = bridge.onState(next => { updated = true; if (active) setAccount(next); });
    void bridge.state().then(next => { if (active && !updated) setAccount(next); }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, [bridge]);
  const view = bridge ? cloudPlanView(account) : null;
  const record = state.config?.onboarding;
  const kind = view ? cloudNoticeKind(view, account) : null;
  const trial = plan?.trial;
  const key = trial ? `${trial.state}:${trial.endsAt}` : null;
  const retiredPhones = phonesToTell(linkPhones, record);
  const waits = cornerPopupWaits(state, updater, { quiet, idle: true, viewer, duringFirstChat: true })
    || firstChatQuiet(state) || welcome.due || Boolean(state.cloudAdd) || state.cloudHowTo;
  const facts = Object.fromEntries(NOTICES.map(id => [id, false])) as NoticeFacts;
  facts[PHONE_UPDATE_NOTICE] = retiredPhones?.length === 0 ? false
    : retiredPhones === undefined || !viewer || (state.liveCall && state.liveCall.status !== "ended") ? null : true;
  facts[TWO_PLACES_NOTICE] = !local || two.suggest === null ? false : two.suggest === undefined ? null : true;
  facts[CLOUD_TRIAL_NOTICE] = planBridge && plan === null ? null : Boolean(key && (cloudTrialNotice(plan) || trialOpen === key));
  facts[CLOUD_NOTICE] = !view ? false : view.kind === "unknown" ? null
    : Boolean(kind && !noticeSeen(record, CLOUD_NOTICE_CARD[kind].dismissed));
  const notice = waits ? null : nextNotice(facts, () => false, launchNotice(), closed);
  const shownKey = notice === CLOUD_TRIAL_NOTICE ? key : notice;
  useEffect(() => {
    if (!shownKey || !notice) return;
    markLaunchNotice(notice);
    if (notice === CLOUD_TRIAL_NOTICE && trialOpen !== shownKey) {
      setTrialOpen(shownKey);
      void planBridge?.noticeSeen?.().catch(() => {});
    }
  }, [shownKey]);
  const save = (patch: { onboarding: { hintsSeen: string[] } } | null) => {
    if (patch) void api("/api/config", { method: "PUT", body: JSON.stringify(patch) })
      .then(config => dispatch({ type: "configStatus", config })).catch(() => {});
  };
  const close = () => { setClosed(true); setTrialOpen(null); setFailed(false); };
  if (notice === PHONE_UPDATE_NOTICE && retiredPhones?.length) {
    const done = () => { close(); save(dismissNotices(record, retiredPhones.map(phone => phoneUpdateHint(phone.id)))); };
    return <PhoneUpdateCard phones={retiredPhones} onOpen={() => { done(); dispatch(phonePairingSettingsAction()); }} onDismiss={done} />;
  }
  if (notice === TWO_PLACES_NOTICE && two.suggest) {
    const { key } = two.suggest;
    return <TwoPlacesCard key={key} suggest={two.suggest} onBring={() => two.accept(key).then(close)} onDismiss={() => { two.dismiss(key); close(); }} />;
  }
  if (notice === CLOUD_TRIAL_NOTICE && trial) {
    const act = () => { setFailed(false); void planBridge?.manage().then(close, () => setFailed(true)); };
    return <CloudTrialNoticeCard view={cloudTrialView(trial, plan?.credit)} failed={failed} onAction={act} onClose={close} />;
  }
  if (notice === CLOUD_NOTICE && kind && bridge) {
    const act = () => {
      if (busy) return;
      setFailed(false); setBusy(true);
      void cloudNoticeStep(kind, bridge).then(setAccount, () => setFailed(true)).finally(() => setBusy(false));
    };
    return <CloudNoticeCard kind={kind} busy={busy} failed={failed} onAction={act} onNotNow={() => { close(); save(dismissNotice(record, CLOUD_NOTICE_CARD[kind].dismissed)); }} />;
  }
  return null;
}
