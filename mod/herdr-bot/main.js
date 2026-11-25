// herdr-bot for herdr-app: chat with your agents and let them talk to each other.
// The UI lives here; the host (turn-taking, transcripts, agents via hc) runs as `herdr-bot serve` and is
// reached over a loopback WebSocket. See client.js, host.js and state.js for the logic behind this view.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { appHome, checking, hc, home, readTextFile, theme } from "herdr";
import { WebSocket } from "websocket";
import { AppApiClient } from "./client.js";
import { HostMissingError, connectToHost, hostLaunchArgs, isHostAlreadyStarting } from "./host.js";
import { applyEvent, statusOf, summarize, visibleChats } from "./state.js";

const MAX_BACKOFF_MS = 10000;

/** Where the host keeps its files; `<appHome>/herdr-bot.json` {"home": "..."} overrides ~/.herdr-bot. */
async function loadBotHome() {
  let botHome = `${home()}/.herdr-bot`;
  try {
    const raw = await readTextFile(`${appHome()}/herdr-bot.json`);
    const configured = raw == null ? null : JSON.parse(raw).home;
    if (typeof configured === "string" && configured.length > 0) botHome = configured;
  } catch {
    // an unreadable override is the same as none
  }
  return botHome;
}

async function readEndpoint(botHome) {
  try {
    const raw = await readTextFile(`${botHome}/ws.json`);
    const parsed = raw == null ? null : JSON.parse(raw);
    return parsed != null && typeof parsed.port === "number" && typeof parsed.token === "string" ? parsed : null;
  } catch {
    return null;
  }
}

async function startHost(botHome) {
  const shimPath = `${botHome}/bin/herdr-bot`;
  if ((await readTextFile(shimPath)) == null) throw new HostMissingError(`herdr-bot is not installed: ${shimPath} is missing`);
  const result = await hc(hostLaunchArgs({ botHome, shimPath }));
  if (result.code !== 0 && !isHostAlreadyStarting(result)) throw new Error(`could not start the herdr-bot host: ${(result.stderr || result.stdout).trim().slice(0, 200)}`);
}

const PHASE_TEXT = {
  connecting: "Connecting to herdr-bot…",
  starting: "Starting the herdr-bot host…",
  disconnected: "Lost the host. Reconnecting…",
};

export default class HerdrBot extends View {
  init(props, cx) {
    this.phase = "connecting";
    this.error = null;
    this.chats = [];
    this.selected = null;
    this.client = null;
    this.alive = true;
    this.retryRequested = false;
    // `herdr-app check` runs init() for real: start nothing there.
    if (checking()) return;
    cx.spawn(async (cx) => this.lifecycle(cx));
  }

  async close() {
    this.alive = false;
    // The host stops itself shortly after the last client leaves, so there is nothing else to clean up.
    await this.client?.close();
  }

  async lifecycle(cx) {
    const botHome = await loadBotHome();
    let backoff = 1000;
    while (this.alive) {
      let fatal = false;
      try {
        this.phase = "connecting";
        this.error = null;
        cx.notify();
        const client = await connectToHost({
          readEndpoint: () => readEndpoint(botHome),
          startHost: () => startHost(botHome),
          connect: async (endpoint) => {
            const next = new AppApiClient({
              connect: (url) => WebSocket.connect(url),
              sleep: (ms) => cx.sleep(ms),
              onEvent: (event) => {
                this.chats = applyEvent(this.chats, event);
                cx.notify();
              },
            });
            await next.open(endpoint);
            return next;
          },
          sleep: (ms) => cx.sleep(ms),
          now: () => Date.now(),
          onPhase: (phase) => {
            this.phase = phase;
            cx.notify();
          },
        });
        this.client = client;
        backoff = 1000;
        const pump = client.pump();
        this.chats = await client.request("chat.list");
        this.phase = "ready";
        cx.notify();
        await pump;
        this.phase = "disconnected";
      } catch (error) {
        fatal = error instanceof HostMissingError;
        this.error = String((error && error.message) || error);
        this.phase = fatal ? "missing" : "error";
      }
      this.client = null;
      cx.notify();
      if (fatal) {
        // Nothing to retry until the person installs herdr-bot (or presses Retry).
        this.retryRequested = false;
        while (this.alive && !this.retryRequested) await cx.sleep(500);
      } else {
        await cx.sleep(backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    }
  }

  mark(t, status) {
    if (status === "blocked") {
      return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    }
    if (status === "working") return div().size(8).mx(3).flex_none().rounded(4).bg(t.working).loop("opacity", { from: 0.35, to: 1, period: 1100 });
    if (status === "idle") return div().size(8).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    if (status === "done") return div().size(8).mx(3).flex_none().rounded(4).bg(t.done);
    return div().size(8).mx(3).flex_none().rounded(4).bg(t.dim + "66");
  }

  row(t, chat) {
    const status = statusOf(chat);
    const on = chat.id === this.selected;
    return h_flex()
      .id(`chat-${chat.id}`)
      .px(10)
      .py(8)
      .gap(10)
      .rounded(8)
      .flex_none()
      .items_center()
      .when(on, (el) => el.bg(t.raised))
      .hover((el) => el.bg(t.hover))
      .on_click((_event, cx) => {
        this.selected = chat.id;
        cx.notify();
      })
      .child(div().size(30).flex_none().rounded(15).bg(t.raised).flex().items_center().justify_center().text_size(13).font_semibold().text_color(t.foreground).child((chat.name || "?").slice(0, 1).toUpperCase()))
      .child(
        v_flex()
          .flex_1()
          .gap(1)
          .child(div().truncate().text_size(13).font_semibold().text_color(t.foreground).child(chat.name))
          .child(div().truncate().text_size(11.5).text_color(t.muted).child(chat.lastMessagePreview || (chat.kind === "room" ? "Room" : chat.bot?.provider ?? "Bot"))),
      )
      .when(chat.unreadCount > 0, (el) => el.child(div().flex_none().min_w(18).h(18).px(5).rounded(9).bg(t.accent).text_size(10.5).font_semibold().text_color(t.accent_foreground).flex().items_center().justify_center().child(String(chat.unreadCount))))
      .child(this.mark(t, status));
  }

  notice(t, text, detail, action) {
    return v_flex()
      .flex_1()
      .items_center()
      .justify_center()
      .gap(8)
      .px(24)
      .child(div().text_size(13).text_color(t.foreground).child(text))
      .when(Boolean(detail), (el) => el.child(div().text_size(11.5).text_color(t.muted).child(detail)))
      .when(Boolean(action), (el) => el.child(
        div()
          .id("retry")
          .mt(4)
          .px(12)
          .h(28)
          .rounded(7)
          .bg(t.solid)
          .text_color(t.solid_foreground)
          .text_size(12)
          .font_semibold()
          .flex()
          .items_center()
          .cursor_pointer()
          .on_click((_event, cx) => {
            this.retryRequested = true;
            cx.notify();
          })
          .child(action),
      ));
  }

  render() {
    const t = theme();
    const chats = visibleChats(this.chats.slice());
    const counts = summarize(this.chats);
    const body = (() => {
      if (this.phase === "ready") {
        if (chats.length === 0) return this.notice(t, "No bots yet", "Create one to start chatting with an agent.");
        return v_flex().id("chat-list").flex_1().overflow_y_scroll().p(6).gap(2).children(chats.map((chat) => this.row(t, chat)));
      }
      if (this.phase === "missing") return this.notice(t, "herdr-bot is not installed", this.error, "Retry");
      if (this.phase === "error") return this.notice(t, "Cannot reach herdr-bot", this.error);
      return this.notice(t, PHASE_TEXT[this.phase] ?? "Connecting…");
    })();
    return v_flex()
      .id("herdr-bot")
      .size_full()
      .bg(t.chrome)
      .text_color(t.foreground)
      .child(
        h_flex()
          .h(40)
          .px(14)
          .flex_none()
          .items_center()
          .gap(8)
          .border_b(1)
          .border_color(t.border)
          .child(div().flex_1().text_size(13).font_semibold().child("herdr-bot"))
          .when(counts.blocked > 0, (el) => el.child(div().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child(`${counts.blocked} need you`)))
          .when(counts.working > 0, (el) => el.child(div().text_size(11).text_color(t.muted).child(`${counts.working} working`))),
      )
      .child(body);
  }
}
