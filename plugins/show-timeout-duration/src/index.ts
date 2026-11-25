// @description Shows remaining timeout duration beside usernames
// @version 0.1.0
// @author hakuxyz, port of Valenced "Show Timeout Duration" by Palm

const { gateway, discord, ui } = phoenix;
const RED = 0xffed4245;
const ICON = "res://design_components_icon_native_redesign_generated_images_clockwarningicon";
const REFRESH = 60_000;
const DEBUG = true;
const log = (...args: unknown[]) => {
  if (DEBUG) phoenix.log.info("[timeout]", ...args);
};

type Member = {
  user?: { id?: string };
  user_id?: string;
  communication_disabled_until?: string | null;
  communicationDisabledUntil?: string | null;
};

type Message = {
  id?: string;
  author?: { id?: string };
  guild_id?: string;
  guildId?: string;
  member?: Member;
};

type Author = { user: string; guild?: string };

const pad = (id: string) => id.padStart(20, "0");
const at = (guild: string | undefined, user: string) => `${guild ?? ""}:${user}`;
const endOf = (value: string | null | undefined) => {
  const end = value ? Date.parse(value) : 0;
  return Number.isFinite(end) && end > Date.now() ? end : 0;
};

const authors = new Map<string, Author>();
const ends = new Map<string, number>();
const fetchedAt = new Map<string, number>();
// one mount per row (by parent) so recycled rows don't keep old badges
const byParent = new Map<number, Array<() => void>>();
const byMessage = new Map<string, number>();

const rememberMember = (member: Member, guild?: string) => {
  const user = member.user?.id ?? member.user_id;
  if (!user) return;
  const end = endOf(member.communication_disabled_until ?? member.communicationDisabledUntil);
  const id = at(guild, user);
  if (end) ends.set(id, end);
  else ends.delete(id);
};

const rememberMessage = (message: Message) => {
  if (!message.id || !message.author?.id) return;
  const guild = message.guild_id ?? message.guildId;
  authors.set(message.id, { user: message.author.id, guild });
  if (message.member) rememberMember(message.member, guild);
};

phoenix.hook(gateway.messageCreate, { after: rememberMessage });
phoenix.hook(gateway.messageUpdate, { after: rememberMessage });
phoenix.on(gateway.messageDelete, (message) => authors.delete(message.id));
phoenix.on(gateway.messageDeleteBulk, (message) => {
  for (const id of message.ids) authors.delete(id);
});

// filled from member endpoints and message payloads
discord.onResponse({ pathIncludes: "/members" }, (res) => {
  if (res.status < 200 || res.status >= 300) return;
  const guild = res.path.split("/")[2];
  try {
    const body = res.json<Member | Member[] | null>();
    const list = Array.isArray(body) ? body : body ? [body] : [];
    for (const member of list) rememberMember(member, guild);
  } catch {
    return;
  }
});

discord.onResponse({ pathIncludes: "/messages" }, (res) => {
  if (res.status < 200 || res.status >= 300) return;
  try {
    const body = res.json<Message | Message[] | null>();
    const list = Array.isArray(body) ? body : body ? [body] : [];
    for (const msg of list) {
      if (msg.member && msg.author?.id) {
        rememberMember(msg.member, msg.guild_id ?? msg.guildId);
      }
    }
  } catch {
    return;
  }
});

const cachedAuthor = async (id: string) => {
  const rows = await phoenix.stores.sql<{ v: string }>(
    "SELECT CAST(v AS TEXT) AS v FROM messages WHERE k LIKE ? LIMIT 1",
    `%:${pad(id)}`,
  );
  const raw = rows[0]?.v;
  if (!raw) return undefined;
  try {
    const message = JSON.parse(raw) as Message;
    rememberMessage({ ...message, id });
    return authors.get(id);
  } catch {
    return undefined;
  }
};

const cachedEnd = async (guild: string | undefined, user: string) => {
  const rows = await phoenix.stores.sql<{ k: string; v: string }>(
    "SELECT k, CAST(v AS TEXT) AS v FROM members WHERE k LIKE ? LIMIT 20",
    `%:${pad(user)}`,
  );
  for (const row of rows) {
    const fromKey = row.k.split(":")[0]?.replace(/^0+/, "") || undefined;
    if (guild && fromKey && fromKey !== guild) continue;
    try {
      const member = JSON.parse(row.v) as Member;
      const end = endOf(member.communication_disabled_until ?? member.communicationDisabledUntil);
      if (end) return end;
    } catch {
      continue;
    }
  }
  return 0;
};

const askedEnd = async (guild: string | undefined, user: string) => {
  if (!guild) return 0;
  const id = at(guild, user);
  if ((fetchedAt.get(id) ?? 0) > Date.now()) return 0;
  fetchedAt.set(id, Date.now() + REFRESH);
  try {
    const res = await discord.get(`/guilds/${guild}/members/${user}`);
    if (res.status < 200 || res.status >= 300) return 0;
    const member = res.json<Member | null>();
    if (member) rememberMember(member, guild);
    return ends.get(id) ?? 0;
  } catch {
    return 0;
  }
};

const timeoutEnd = async (author: Author) => {
  const id = at(author.guild, author.user);
  return (
    ends.get(id) ||
    (await cachedEnd(author.guild, author.user)) ||
    (await askedEnd(author.guild, author.user))
  );
};

const format = (ms: number) => {
  const totalSeconds = Math.ceil(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
};

const clearParent = (parent: number) => {
  const removers = byParent.get(parent);
  log("clearParent", parent, "removers", removers?.length ?? 0);
  for (const remove of removers ?? []) {
    try { remove(); } catch {}
  }
  byParent.delete(parent);
  for (const [msg, atParent] of byMessage) {
    if (atParent === parent) byMessage.delete(msg);
  }
};

const clearMarks = (id: string) => {
  const parent = byMessage.get(id);
  if (parent != null) {
    log("clearMarks", id, "parent", parent);
    clearParent(parent);
  }
  byMessage.delete(id);
};

const place = (id: string, node: Phoenix.NodeInfo, remaining: number) => {
  const parent = node.parent;
  if (parent == null) return;
  // reused row
  const prev = byMessage.get(id);
  if (prev != null && prev !== parent) clearParent(prev);
  clearParent(parent);
  log("mount", id, "node", node.id, "parent", parent);
  byMessage.set(id, parent);
  const gap8 = (ui.node(parent)?.children ?? []).some((child) =>
    ui.node(child)?.accessibilityId?.startsWith("message.timestamp:"),
  );
  byParent.set(parent, [
    ui.patchProps({ exact: `message.author:${id}` }, { color: RED, margin: [0, 0, 0, 0] }),
    ui.mount(
      parent,
      {
        kind: "view",
        props: { direction: "row", align: "center", margin: [0, 0, gap8 ? -6 : -2, 0] },
        children: [
          { kind: "image", props: { uri: ICON, width: 14, height: 14, tint: RED } },
          {
            kind: "text",
            props: {
              text: format(remaining),
              color: RED,
              fontSize: 12,
              margin: [1.5, 0, 0, 0],
            },
          },
        ],
      },
      { before: node.id },
    ),
  ]);
};

// The author node may not exist yet; onNode fires when it does
ui.onNode({ prefix: "message.author:" }, (node) => {
  const aid = node.accessibilityId;
  if (!aid) return;
  const messageId = aid.slice("message.author:".length);
  if (!messageId) return;
  const author = authors.get(messageId);
  if (author) {
    const end = ends.get(at(author.guild, author.user));
    if (end && end > Date.now()) {
      place(messageId, node, end - Date.now());
      return;
    }
  }
  resolveAndPlace(messageId, node);
});

const resolveAndPlace = async (messageId: string, node: Phoenix.NodeInfo) => {
  const author = authors.get(messageId) ?? (await cachedAuthor(messageId));
  if (!author) return;
  const end = await timeoutEnd(author);
  const remaining = end - Date.now();
  const live = ui.node(node.id);
  if (!live) return;
  if (remaining <= 0) {
    clearMarks(messageId);
    return;
  }
  place(messageId, live, remaining);
};

phoenix.onUnload(() => {
  for (const parent of [...byParent.keys()]) clearParent(parent);
  byMessage.clear();
  authors.clear();
  ends.clear();
  fetchedAt.clear();
});
