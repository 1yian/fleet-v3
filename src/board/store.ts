import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  BoardError,
  CARD_STATES,
  DELIVERIES,
  ENTRY_KINDS,
  EVENT_TYPES,
  MateNameSchema,
  SERVER_ACTOR,
  runnerActor,
  type AdvertiseHostInput,
  type AnswerCardInput,
  type BoardEvent,
  type BoardEventType,
  type BoardOverview,
  type CancelCardInput,
  type Card,
  type CardState,
  type CardPage,
  type CardThread,
  type ClaimFenceInput,
  type ClaimNextInput,
  type ClaimReceipt,
  type CloseCardInput,
  type CreateCardInput,
  type Delivery,
  type Entry,
  type EntryKind,
  type EscalateCardInput,
  type FinishClaimInput,
  type HandoffCardInput,
  type HostInfo,
  type ListCardsQuery,
  type OptionalFenceInput,
  type PostEntryInput,
  type QueueCardInput,
} from "./types.ts";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mate TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,
  holder TEXT NOT NULL,
  project TEXT,
  host TEXT,
  delivery TEXT,
  needs_json TEXT NOT NULL DEFAULT '[]',
  labels_json TEXT NOT NULL DEFAULT '{}',
  result TEXT NOT NULL DEFAULT '',
  epoch INTEGER NOT NULL DEFAULT 0,
  claim_token_hash TEXT,
  worker_token_hash TEXT,
  claim_by TEXT,
  lease_until INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cards_state_holder ON cards (state, holder, updated_at);
CREATE INDEX IF NOT EXISTS idx_cards_mate_state ON cards (mate, state, id);
CREATE INDEX IF NOT EXISTS idx_cards_queued_host ON cards (state, host, id);

CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  by TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'reply',
  text TEXT NOT NULL,
  internal INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entries_card ON entries (card_id, id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  card_id INTEGER,
  mate TEXT,
  holder TEXT,
  actor TEXT,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_type_id ON events (type, id);
`;

const CardStateSchema = z.enum(CARD_STATES);
const StringArraySchema = z.array(z.string());
const StringRecordSchema = z.record(z.string(), z.string());
const UnknownRecordSchema = z.record(z.string(), z.unknown());

const CardRowSchema = z.object({
  id: z.number().int(),
  mate: z.string(),
  title: z.string(),
  body: z.string(),
  state: z.enum(CARD_STATES),
  holder: z.string(),
  project: z.string().nullable(),
  host: z.string().nullable(),
  delivery: z.enum(DELIVERIES).nullable(),
  needs_json: z.string(),
  labels_json: z.string(),
  result: z.string(),
  epoch: z.number().int(),
  claim_token_hash: z.string().nullable(),
  worker_token_hash: z.string().nullable(),
  claim_by: z.string().nullable(),
  lease_until: z.number().int().nullable(),
  created_by: z.string(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  entry_count: z.number().int().optional(),
});

const EntryRowSchema = z.object({
  id: z.number().int(),
  card_id: z.number().int(),
  by: z.string(),
  kind: z.enum(ENTRY_KINDS),
  text: z.string(),
  internal: z.number().int(),
  created_at: z.number().int(),
});

const EventRowSchema = z.object({
  id: z.number().int(),
  type: z.enum(EVENT_TYPES),
  card_id: z.number().int().nullable(),
  mate: z.string().nullable(),
  holder: z.string().nullable(),
  actor: z.string().nullable(),
  payload_json: z.string(),
  created_at: z.number().int(),
});

const HostPayloadSchema = z.object({
  host: z.string(),
  mode: z.string(),
  viewport: z.string(),
  repos: z.array(z.string()),
});

type CardRow = z.infer<typeof CardRowSchema>;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function tokenMatches(token: string, expectedHash: string | null): boolean {
  if (expectedHash === null) return false;
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function parseCardId(raw: string): number {
  const cleaned = raw.trim().replace(/^#/u, "");
  if (!/^\d+$/u.test(cleaned)) {
    throw new BoardError(400, "invalid_id", `Invalid card id: "${raw}"`);
  }
  const num = Number(cleaned);
  if (!Number.isSafeInteger(num) || num <= 0) {
    throw new BoardError(400, "invalid_id", `Invalid card id: "${raw}"`);
  }
  return num;
}

function parseMateName(mate: string): string {
  const parsed = MateNameSchema.safeParse(mate);
  if (!parsed.success) {
    throw new BoardError(400, "invalid_mate", `Invalid mate name: "${mate}"`);
  }
  return parsed.data;
}

function rowToCard(row: CardRow): Card {
  return {
    id: String(row.id),
    mate: row.mate,
    title: row.title,
    body: row.body,
    state: row.state,
    holder: row.holder,
    project: row.project,
    host: row.host,
    delivery: row.delivery,
    needs: StringArraySchema.parse(JSON.parse(row.needs_json)),
    labels: StringRecordSchema.parse(JSON.parse(row.labels_json)),
    result: row.result,
    epoch: row.epoch,
    claimBy: row.claim_by,
    leaseUntil: row.lease_until,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    entryCount: row.entry_count ?? 0,
  };
}

function rowToEntry(raw: unknown): Entry {
  const row = EntryRowSchema.parse(raw);
  return {
    id: String(row.id),
    cardId: String(row.card_id),
    by: row.by,
    kind: row.kind,
    text: row.text,
    internal: row.internal !== 0,
    createdAt: row.created_at,
  };
}

function rowToEvent(raw: unknown): BoardEvent {
  const row = EventRowSchema.parse(raw);
  return {
    id: row.id,
    type: row.type,
    cardId: row.card_id === null ? null : String(row.card_id),
    mate: row.mate,
    holder: row.holder,
    actor: row.actor,
    payload: UnknownRecordSchema.parse(JSON.parse(row.payload_json)),
    createdAt: row.created_at,
  };
}

export interface CardStoreOptions {
  readonly dataDir?: string;
  readonly memory?: boolean;
  readonly parents?: Readonly<Record<string, string>>;
  readonly now?: () => number;
}

const CARD_SELECT = `
SELECT c.*, (SELECT COUNT(*) FROM entries e WHERE e.card_id = c.id) AS entry_count
FROM cards c
`;

export class CardStore {
  private readonly db: DatabaseSync;
  private readonly dataDir: string | undefined;
  private readonly parents: Record<string, string>;
  private readonly nowFn: () => number;
  private readonly memoryCharters = new Map<string, string>();
  private memoryPrefs = "";
  private readonly listeners = new Set<(event: BoardEvent) => void>();
  private readonly pendingEvents: BoardEvent[] = [];
  private publishing = false;

  public constructor(options: CardStoreOptions = {}) {
    this.nowFn = options.now ?? (() => Date.now());
    this.parents = { ...options.parents };
    if (options.memory === true || options.dataDir === undefined) {
      this.dataDir = undefined;
      this.db = new DatabaseSync(":memory:");
    } else {
      this.dataDir = options.dataDir;
      mkdirSync(options.dataDir, { recursive: true });
      const dbPath = join(options.dataDir, "fleet.db");
      mkdirSync(dirname(dbPath), { recursive: true });
      this.db = new DatabaseSync(dbPath);
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA busy_timeout = 5000;");
    }
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA_SQL);
  }

  public close(): void {
    this.listeners.clear();
    this.db.close();
  }

  public subscribe(listener: (event: BoardEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public getParents(): Record<string, string> {
    return { ...this.parents };
  }

  public parentOf(holder: string): string {
    if (holder === "captain") return "captain";
    return Object.hasOwn(this.parents, holder) ? (this.parents[holder] ?? "captain") : "captain";
  }

  private publish(events: readonly BoardEvent[]): void {
    this.pendingEvents.push(...events);
    if (this.publishing) return;
    this.publishing = true;
    try {
      let event = this.pendingEvents.shift();
      while (event !== undefined) {
        for (const listener of this.listeners) {
          try {
            listener(event);
          } catch {
            continue;
          }
        }
        event = this.pendingEvents.shift();
      }
    } finally {
      this.publishing = false;
    }
  }

  private runTransaction<T>(fn: () => { readonly result: T; readonly events: BoardEvent[] }): T {
    this.db.exec("BEGIN IMMEDIATE");
    let outcome: { readonly result: T; readonly events: BoardEvent[] };
    try {
      outcome = fn();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.publish(outcome.events);
    return outcome.result;
  }

  private appendEvent(params: {
    readonly type: BoardEventType;
    readonly cardId?: number | null;
    readonly mate?: string | null;
    readonly holder?: string | null;
    readonly actor?: string | null;
    readonly payload: Record<string, unknown>;
    readonly createdAt: number;
  }): BoardEvent {
    const info = this.db
      .prepare(
        `INSERT INTO events (type, card_id, mate, holder, actor, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.type,
        params.cardId ?? null,
        params.mate ?? null,
        params.holder ?? null,
        params.actor ?? null,
        JSON.stringify(params.payload),
        params.createdAt,
      );
    return {
      id: Number(info.lastInsertRowid),
      type: params.type,
      cardId: params.cardId === undefined || params.cardId === null ? null : String(params.cardId),
      mate: params.mate ?? null,
      holder: params.holder ?? null,
      actor: params.actor ?? null,
      payload: params.payload,
      createdAt: params.createdAt,
    };
  }

  private insertEntry(params: {
    readonly cardId: number;
    readonly by: string;
    readonly kind: EntryKind;
    readonly text: string;
    readonly internal: boolean;
    readonly createdAt: number;
  }): Entry {
    const info = this.db
      .prepare(
        `INSERT INTO entries (card_id, by, kind, text, internal, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.cardId,
        params.by,
        params.kind,
        params.text,
        params.internal ? 1 : 0,
        params.createdAt,
      );
    return {
      id: String(Number(info.lastInsertRowid)),
      cardId: String(params.cardId),
      by: params.by,
      kind: params.kind,
      text: params.text,
      internal: params.internal,
      createdAt: params.createdAt,
    };
  }

  private getCardRow(id: number): CardRow {
    const raw = this.db.prepare(`${CARD_SELECT} WHERE c.id = ?`).get(id);
    if (raw === undefined) {
      throw new BoardError(404, "card_not_found", `Card #${String(id)} not found`);
    }
    return CardRowSchema.parse(raw);
  }

  private static assertFence(
    row: CardRow,
    fence: ClaimFenceInput,
    now: number,
    holder: "runner" | "worker",
  ): void {
    const leaseValid = row.lease_until !== null && row.lease_until > now;
    const expectedHash = holder === "runner" ? row.claim_token_hash : row.worker_token_hash;
    if (
      row.state !== "running" ||
      row.epoch !== fence.epoch ||
      !leaseValid ||
      !tokenMatches(fence.token, expectedHash)
    ) {
      throw new BoardError(
        409,
        "claim_lost",
        `Claim on card #${String(row.id)} is no longer valid`,
      );
    }
  }

  private static guardFence(row: CardRow, input: OptionalFenceInput, now: number): void {
    if (input.epoch === undefined && input.token === undefined) return;
    if (input.epoch === undefined || input.token === undefined) {
      throw new BoardError(400, "invalid_fence", "epoch and token must be provided together");
    }
    CardStore.assertFence(row, { epoch: input.epoch, token: input.token }, now, "worker");
  }

  private expireLeasesInternal(now: number): BoardEvent[] {
    const rows = this.db
      .prepare(
        `${CARD_SELECT} WHERE c.state = 'running' AND c.lease_until IS NOT NULL AND c.lease_until <= ?`,
      )
      .all(now);
    const events: BoardEvent[] = [];
    for (const raw of rows) {
      const row = CardRowSchema.parse(raw);
      this.db
        .prepare(
          `UPDATE cards
           SET state = 'queued', holder = 'runner', claim_token_hash = NULL, worker_token_hash = NULL, claim_by = NULL,
               lease_until = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(now, row.id);
      events.push(
        this.appendEvent({
          type: "card.expired",
          cardId: row.id,
          mate: row.mate,
          holder: "runner",
          actor: SERVER_ACTOR,
          payload: { id: String(row.id), epoch: row.epoch, title: row.title },
          createdAt: now,
        }),
      );
    }
    return events;
  }

  private unmetNeeds(needs: readonly string[]): string[] {
    return needs.filter((needId) => {
      const prereq = this.db
        .prepare("SELECT state FROM cards WHERE id = ?")
        .get(parseCardId(needId));
      return prereq === undefined || Reflect.get(prereq, "state") !== "done";
    });
  }

  private dependentsOf(prerequisiteId: string, states: readonly CardState[]): CardRow[] {
    return this.db
      .prepare(
        `${CARD_SELECT} WHERE c.state IN (${states.map(() => "?").join(", ")}) ORDER BY c.id`,
      )
      .all(...states)
      .map((raw) => CardRowSchema.parse(raw))
      .filter((row) =>
        StringArraySchema.parse(JSON.parse(row.needs_json)).includes(prerequisiteId),
      );
  }

  private unblockDependentsInternal(completedId: string, now: number): BoardEvent[] {
    const events: BoardEvent[] = [];
    for (const row of this.dependentsOf(completedId, ["waiting"])) {
      if (this.unmetNeeds(StringArraySchema.parse(JSON.parse(row.needs_json))).length > 0) continue;
      const readyForRunner = row.host !== null && row.project !== null;
      const nextState: CardState = readyForRunner ? "queued" : "held";
      const nextHolder = readyForRunner ? "runner" : row.mate;
      this.db
        .prepare(`UPDATE cards SET state = ?, holder = ?, updated_at = ? WHERE id = ?`)
        .run(nextState, nextHolder, now, row.id);
      events.push(
        this.appendEvent({
          type: readyForRunner ? "card.queued" : "card.handed_off",
          cardId: row.id,
          mate: row.mate,
          holder: nextHolder,
          actor: SERVER_ACTOR,
          payload: {
            id: String(row.id),
            title: row.title,
            unblockedBy: completedId,
          },
          createdAt: now,
        }),
      );
    }
    return events;
  }

  private holdDependentsOfCanceled(canceledId: string, now: number): BoardEvent[] {
    const events: BoardEvent[] = [];
    const text = `Prerequisite #${canceledId} was canceled; resolve and close this card manually, or cancel it.`;
    for (const row of this.dependentsOf(canceledId, ["waiting", "held"])) {
      const rowId = String(row.id);
      const entry = this.insertEntry({
        cardId: row.id,
        by: SERVER_ACTOR,
        kind: "status",
        text,
        internal: false,
        createdAt: now,
      });
      if (row.state === "held") {
        events.push(
          this.appendEvent({
            type: "entry.posted",
            cardId: row.id,
            mate: row.mate,
            holder: row.holder,
            actor: SERVER_ACTOR,
            payload: {
              id: entry.id,
              cardId: rowId,
              title: row.title,
              text,
              internal: false,
              kind: entry.kind,
            },
            createdAt: now,
          }),
        );
        continue;
      }
      this.db
        .prepare(
          `UPDATE cards SET state = 'held', holder = ?, result = ?, updated_at = ? WHERE id = ?`,
        )
        .run(row.mate, text, now, row.id);
      events.push(
        this.appendEvent({
          type: "card.handed_off",
          cardId: row.id,
          mate: row.mate,
          holder: row.mate,
          actor: SERVER_ACTOR,
          payload: { id: rowId, title: row.title, to: row.mate, text },
          createdAt: now,
        }),
      );
    }
    return events;
  }

  private validateNeeds(needs: readonly string[]): {
    readonly ids: string[];
    readonly allDone: boolean;
  } {
    const unique: string[] = [];
    const seen = new Set<string>();
    let allDone = true;
    for (const rawId of needs) {
      const num = parseCardId(rawId);
      const id = String(num);
      if (seen.has(id)) continue;
      seen.add(id);
      const row = this.getCardRow(num);
      if (row.state === "canceled") {
        throw new BoardError(
          400,
          "invalid_needs",
          `Card #${id} is canceled and can never complete`,
        );
      }
      if (row.state !== "done") allDone = false;
      unique.push(id);
    }
    return { ids: unique, allDone };
  }

  public createCard(input: CreateCardInput): Card {
    const mate = input.mate.trim();
    const title = input.title.trim();
    if (mate.length === 0) throw new BoardError(400, "invalid_mate", "mate is required");
    if (title.length === 0) throw new BoardError(400, "invalid_title", "title is required");

    return this.runTransaction(() => {
      const now = this.nowFn();
      const actor = input.actor ?? mate;
      const needsCheck = this.validateNeeds(input.needs ?? []);
      const hasRunnerTarget = input.host !== undefined && input.project !== undefined;
      const state: CardState =
        needsCheck.ids.length > 0 && !needsCheck.allDone
          ? "waiting"
          : hasRunnerTarget
            ? "queued"
            : "held";
      const holder = state === "queued" ? "runner" : mate;

      const info = this.db
        .prepare(
          `INSERT INTO cards (
            mate, title, body, state, holder, project, host, delivery,
            needs_json, labels_json, result, epoch, created_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0, ?, ?, ?)`,
        )
        .run(
          mate,
          title,
          input.body ?? "",
          state,
          holder,
          input.project ?? null,
          input.host ?? null,
          input.delivery ?? null,
          JSON.stringify(needsCheck.ids),
          "{}",
          actor,
          now,
          now,
        );
      const cardId = Number(info.lastInsertRowid);
      const card = rowToCard(this.getCardRow(cardId));
      const event = this.appendEvent({
        type: state === "queued" ? "card.queued" : "card.created",
        cardId,
        mate: card.mate,
        holder: card.holder,
        actor,
        payload: {
          id: card.id,
          title: card.title,
          state: card.state,
          host: card.host,
          project: card.project,
        },
        createdAt: now,
      });
      return { result: card, events: [event] };
    });
  }

  public getThread(rawId: string): CardThread {
    const id = parseCardId(rawId);
    const card = rowToCard(this.getCardRow(id));
    const entries = this.db
      .prepare("SELECT * FROM entries WHERE card_id = ? ORDER BY id ASC")
      .all(id)
      .map((row) => rowToEntry(row));
    return { card, entries };
  }

  public listCards(query: ListCardsQuery = {}): CardPage {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (query.mate !== undefined && query.mate.length > 0) {
      conditions.push("c.mate = ?");
      params.push(query.mate);
    }
    if (query.holder !== undefined && query.holder.length > 0) {
      conditions.push("c.holder = ?");
      params.push(query.holder);
    }
    const stateFilter = query.state ?? "open";
    if (stateFilter === "open") {
      conditions.push("c.state NOT IN ('done', 'canceled')");
    } else if (stateFilter !== "all") {
      conditions.push("c.state = ?");
      params.push(stateFilter);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limitClause = query.limit === undefined ? "" : "LIMIT ?";
    const rows = this.db
      .prepare(`${CARD_SELECT} ${where} ORDER BY c.id DESC ${limitClause}`)
      .all(...params, ...(query.limit === undefined ? [] : [query.limit]));
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS total FROM cards c ${where}`)
      .get(...params);
    const total: unknown = totalRow === undefined ? 0 : Reflect.get(totalRow, "total");
    return {
      cards: rows.map((raw) => rowToCard(CardRowSchema.parse(raw))),
      total: typeof total === "number" ? total : 0,
    };
  }

  public queueCard(rawId: string, input: QueueCardInput): Card {
    const id = parseCardId(rawId);
    return this.runTransaction(() => {
      const now = this.nowFn();
      const row = this.getCardRow(id);
      CardStore.guardFence(row, input, now);
      if (row.state === "done" || row.state === "canceled") {
        throw new BoardError(409, "card_terminal", `Card #${String(id)} is ${row.state}`);
      }
      if (row.state === "running") {
        throw new BoardError(409, "card_running", `Card #${String(id)} is already running`);
      }
      const open = this.unmetNeeds(StringArraySchema.parse(JSON.parse(row.needs_json)));
      if (open.length > 0) {
        throw new BoardError(
          409,
          "unmet_needs",
          `Card #${String(id)} still needs ${open.map((needId) => `#${needId}`).join(", ")}`,
        );
      }
      const host = input.host ?? row.host;
      const project = input.project ?? row.project;
      const delivery: Delivery | null = input.delivery ?? row.delivery;
      if (host === null || project === null) {
        throw new BoardError(
          400,
          "missing_target",
          "Both host and project are required to queue a card",
        );
      }
      const actor = input.actor ?? row.mate;
      this.db
        .prepare(
          `UPDATE cards
           SET state = 'queued', holder = 'runner', host = ?, project = ?, delivery = ?,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(host, project, delivery, now, id);
      const card = rowToCard(this.getCardRow(id));
      const event = this.appendEvent({
        type: "card.queued",
        cardId: id,
        mate: card.mate,
        holder: "runner",
        actor,
        payload: { id: card.id, title: card.title, host, project, delivery },
        createdAt: now,
      });
      return { result: card, events: [event] };
    });
  }

  public claimNext(input: ClaimNextInput): ClaimReceipt | null {
    return this.runTransaction(() => {
      const now = this.nowFn();
      const events = this.expireLeasesInternal(now);
      const mates = input.mates ?? [];
      let rowRaw: unknown;
      if (mates.length > 0) {
        const placeholders = mates.map(() => "?").join(", ");
        rowRaw = this.db
          .prepare(
            `${CARD_SELECT}
             WHERE c.state = 'queued' AND c.host = ? AND c.mate IN (${placeholders})
             ORDER BY c.id ASC LIMIT 1`,
          )
          .get(input.host, ...mates);
      } else {
        rowRaw = this.db
          .prepare(
            `${CARD_SELECT}
             WHERE c.state = 'queued' AND c.host = ?
             ORDER BY c.id ASC LIMIT 1`,
          )
          .get(input.host);
      }
      if (rowRaw === undefined) {
        return { result: null, events };
      }
      const row = CardRowSchema.parse(rowRaw);
      const nextEpoch = row.epoch + 1;
      const token = randomBytes(24).toString("hex");
      const workerToken = randomBytes(24).toString("hex");
      const leaseUntil = now + input.leaseSeconds * 1000;
      this.db
        .prepare(
          `UPDATE cards
           SET state = 'running', holder = 'worker', epoch = ?, claim_token_hash = ?, worker_token_hash = ?,
               claim_by = ?, lease_until = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          nextEpoch,
          hashToken(token),
          hashToken(workerToken),
          input.claimBy,
          leaseUntil,
          now,
          row.id,
        );
      const card = rowToCard(this.getCardRow(row.id));
      events.push(
        this.appendEvent({
          type: "card.claimed",
          cardId: row.id,
          mate: card.mate,
          holder: "worker",
          actor: input.claimBy,
          payload: { id: card.id, epoch: nextEpoch, host: input.host, leaseUntil },
          createdAt: now,
        }),
      );
      return {
        result: { card, epoch: nextEpoch, token, workerToken, leaseUntil },
        events,
      };
    });
  }

  public renewClaim(
    rawId: string,
    fence: ClaimFenceInput & { readonly leaseSeconds: number },
  ): {
    readonly leaseUntil: number;
  } {
    const id = parseCardId(rawId);
    return this.runTransaction(() => {
      const now = this.nowFn();
      const row = this.getCardRow(id);
      CardStore.assertFence(row, fence, now, "runner");
      const leaseUntil = now + fence.leaseSeconds * 1000;
      this.db
        .prepare("UPDATE cards SET lease_until = ?, updated_at = ? WHERE id = ?")
        .run(leaseUntil, now, id);
      return { result: { leaseUntil }, events: [] };
    });
  }

  public releaseClaim(rawId: string, fence: ClaimFenceInput): Card {
    const id = parseCardId(rawId);
    return this.runTransaction(() => {
      const now = this.nowFn();
      const row = this.getCardRow(id);
      CardStore.assertFence(row, fence, now, "runner");
      this.db
        .prepare(
          `UPDATE cards
           SET state = 'queued', holder = 'runner', claim_token_hash = NULL, worker_token_hash = NULL,
               claim_by = NULL, lease_until = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(now, id);
      const card = rowToCard(this.getCardRow(id));
      const event = this.appendEvent({
        type: "card.queued",
        cardId: id,
        mate: card.mate,
        holder: "runner",
        actor: row.claim_by ?? "runner",
        payload: { id: card.id, released: true },
        createdAt: now,
      });
      return { result: card, events: [event] };
    });
  }

  public finishClaim(rawId: string, input: FinishClaimInput): Card {
    const id = parseCardId(rawId);
    return this.runTransaction(() => {
      const now = this.nowFn();
      const row = this.getCardRow(id);
      CardStore.assertFence(row, input, now, "runner");
      const actor = input.actor ?? row.claim_by ?? "runner";
      const events: BoardEvent[] = [];

      if (input.outcome === "done") {
        this.db
          .prepare(
            `UPDATE cards
             SET state = 'done', holder = '', result = ?, claim_token_hash = NULL, worker_token_hash = NULL,
                 claim_by = NULL, lease_until = NULL, updated_at = ?
             WHERE id = ?`,
          )
          .run(input.summary, now, id);
        const card = rowToCard(this.getCardRow(id));
        events.push(
          this.appendEvent({
            type: "card.done",
            cardId: id,
            mate: card.mate,
            holder: card.mate,
            actor,
            payload: { id: card.id, title: card.title, result: input.summary },
            createdAt: now,
          }),
          ...this.unblockDependentsInternal(card.id, now),
        );
        return { result: card, events };
      }

      const labels = StringRecordSchema.parse(JSON.parse(row.labels_json));
      if (input.kind !== undefined) labels["return_kind"] = input.kind;
      this.db
        .prepare(
          `UPDATE cards
           SET state = 'held', holder = ?, result = ?, labels_json = ?, claim_token_hash = NULL, worker_token_hash = NULL,
               claim_by = NULL, lease_until = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(row.mate, input.summary, JSON.stringify(labels), now, id);
      if (input.summary.trim().length > 0) {
        this.insertEntry({
          cardId: id,
          by: actor,
          kind: "status",
          text: input.summary,
          internal: false,
          createdAt: now,
        });
      }
      const card = rowToCard(this.getCardRow(id));
      events.push(
        this.appendEvent({
          type: "card.returned",
          cardId: id,
          mate: card.mate,
          holder: card.mate,
          actor,
          payload: { id: card.id, title: card.title, summary: input.summary, kind: input.kind },
          createdAt: now,
        }),
      );
      return { result: card, events };
    });
  }

  public postEntry(rawId: string, input: PostEntryInput): Entry {
    const id = parseCardId(rawId);
    const text = input.text.trim();
    if (text.length === 0) throw new BoardError(400, "empty_text", "Entry text is required");

    return this.runTransaction(() => {
      const now = this.nowFn();
      const row = this.getCardRow(id);
      CardStore.guardFence(row, input, now);
      const by = input.by ?? "captain";
      const internal = input.internal === true;
      const entry = this.insertEntry({
        cardId: id,
        by,
        kind: input.kind ?? "reply",
        text,
        internal,
        createdAt: now,
      });
      const event = this.appendEvent({
        type: "entry.posted",
        cardId: id,
        mate: row.mate,
        holder: row.holder,
        actor: by,
        payload: {
          id: entry.id,
          cardId: String(id),
          title: row.title,
          text,
          internal,
          kind: entry.kind,
        },
        createdAt: now,
      });
      return { result: entry, events: [event] };
    });
  }

  public escalateCard(rawId: string, input: EscalateCardInput): Card {
    const id = parseCardId(rawId);
    const reason = input.reason.trim();
    if (reason.length === 0) throw new BoardError(400, "missing_reason", "reason is required");

    return this.runTransaction(() => {
      const now = this.nowFn();
      const row = this.getCardRow(id);
      CardStore.guardFence(row, input, now);
      if (row.state === "done" || row.state === "canceled") {
        throw new BoardError(409, "card_terminal", `Card #${String(id)} is ${row.state}`);
      }
      const actor = input.actor ?? (row.holder === "worker" ? row.mate : row.holder);
      const fromHolder = row.holder === "worker" || row.holder === "runner" ? row.mate : row.holder;
      const targetHolder = this.parentOf(fromHolder);
      if (row.state === "held" && row.holder === targetHolder && row.result === reason) {
        return { result: rowToCard(row), events: [] };
      }
      this.db
        .prepare(
          `UPDATE cards
           SET state = 'held', holder = ?, result = ?,
               claim_token_hash = NULL, worker_token_hash = NULL, claim_by = NULL, lease_until = NULL,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(targetHolder, reason, now, id);
      this.insertEntry({
        cardId: id,
        by: actor,
        kind: "escalation",
        text: reason,
        internal: false,
        createdAt: now,
      });
      const card = rowToCard(this.getCardRow(id));
      const event = this.appendEvent({
        type: "card.escalated",
        cardId: id,
        mate: card.mate,
        holder: targetHolder,
        actor,
        payload: { id: card.id, title: card.title, from: fromHolder, to: targetHolder, reason },
        createdAt: now,
      });
      return { result: card, events: [event] };
    });
  }

  public handoffCard(rawId: string, input: HandoffCardInput): Card {
    const id = parseCardId(rawId);
    return this.runTransaction(() => {
      const now = this.nowFn();
      const row = this.getCardRow(id);
      CardStore.guardFence(row, input, now);
      if (row.state === "done" || row.state === "canceled") {
        throw new BoardError(409, "card_terminal", `Card #${String(id)} is ${row.state}`);
      }
      const trimmedTo = input.to?.trim() ?? "";
      const target = trimmedTo.length > 0 ? trimmedTo : row.mate;
      const actor = input.actor ?? row.holder;
      const text = input.text?.trim() ?? "";
      this.db
        .prepare(
          `UPDATE cards
           SET state = 'held', holder = ?, result = ?,
               claim_token_hash = NULL, worker_token_hash = NULL, claim_by = NULL, lease_until = NULL,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(target, text.length > 0 ? text : row.result, now, id);
      if (text.length > 0) {
        this.insertEntry({
          cardId: id,
          by: actor,
          kind: "reply",
          text,
          internal: false,
          createdAt: now,
        });
      }
      const card = rowToCard(this.getCardRow(id));
      const event = this.appendEvent({
        type: "card.handed_off",
        cardId: id,
        mate: card.mate,
        holder: target,
        actor,
        payload: { id: card.id, title: card.title, to: target, text },
        createdAt: now,
      });
      return { result: card, events: [event] };
    });
  }

  public answerCard(rawId: string, input: AnswerCardInput): Card {
    const id = parseCardId(rawId);
    const text = input.text.trim();
    if (text.length === 0) throw new BoardError(400, "empty_text", "Answer text is required");

    return this.runTransaction(() => {
      const now = this.nowFn();
      const row = this.getCardRow(id);
      CardStore.guardFence(row, input, now);
      if (row.state === "done" || row.state === "canceled") {
        throw new BoardError(409, "card_terminal", `Card #${String(id)} is ${row.state}`);
      }
      const actor = input.actor ?? "captain";
      const target = row.mate;
      this.db
        .prepare(
          `UPDATE cards
           SET state = 'held', holder = ?, result = ?,
               claim_token_hash = NULL, worker_token_hash = NULL, claim_by = NULL, lease_until = NULL,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(target, text, now, id);
      this.insertEntry({
        cardId: id,
        by: actor,
        kind: "answer",
        text,
        internal: false,
        createdAt: now,
      });
      const card = rowToCard(this.getCardRow(id));
      const event = this.appendEvent({
        type: "card.answered",
        cardId: id,
        mate: card.mate,
        holder: target,
        actor,
        payload: { id: card.id, title: card.title, to: target, text },
        createdAt: now,
      });
      return { result: card, events: [event] };
    });
  }

  public closeCard(rawId: string, input: CloseCardInput): Card {
    const id = parseCardId(rawId);
    return this.runTransaction(() => {
      const now = this.nowFn();
      const row = this.getCardRow(id);
      if (input.epoch !== undefined || input.token !== undefined) {
        throw new BoardError(
          409,
          "worker_close_rejected",
          "Workers finish by exiting cleanly so the runner can verify; use handoff when stuck",
        );
      }
      if (row.state === "done") return { result: rowToCard(row), events: [] };
      if (row.state === "canceled") {
        throw new BoardError(409, "card_canceled", `Card #${String(id)} is canceled`);
      }
      const actor = input.actor ?? row.mate;
      const result = input.result?.trim() ?? "";
      this.db
        .prepare(
          `UPDATE cards
           SET state = 'done', holder = '', result = ?,
               claim_token_hash = NULL, worker_token_hash = NULL, claim_by = NULL, lease_until = NULL,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(result.length > 0 ? result : row.result, now, id);
      if (result.length > 0) {
        this.insertEntry({
          cardId: id,
          by: actor,
          kind: "status",
          text: result,
          internal: false,
          createdAt: now,
        });
      }
      const card = rowToCard(this.getCardRow(id));
      const events: BoardEvent[] = [
        this.appendEvent({
          type: "card.done",
          cardId: id,
          mate: card.mate,
          holder: card.mate,
          actor,
          payload: { id: card.id, title: card.title, result: card.result },
          createdAt: now,
        }),
        ...this.unblockDependentsInternal(card.id, now),
      ];
      return { result: card, events };
    });
  }

  public cancelCard(rawId: string, input: CancelCardInput): Card {
    const id = parseCardId(rawId);
    const reason = input.reason.trim();
    if (reason.length === 0) throw new BoardError(400, "missing_reason", "reason is required");

    return this.runTransaction(() => {
      const now = this.nowFn();
      const row = this.getCardRow(id);
      CardStore.guardFence(row, input, now);
      if (row.state === "canceled") return { result: rowToCard(row), events: [] };
      if (row.state === "done") {
        throw new BoardError(409, "card_done", `Card #${String(id)} is already done`);
      }
      const actor = input.actor ?? row.mate;
      this.db
        .prepare(
          `UPDATE cards
           SET state = 'canceled', holder = '', result = ?,
               claim_token_hash = NULL, worker_token_hash = NULL, claim_by = NULL, lease_until = NULL,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(reason, now, id);
      this.insertEntry({
        cardId: id,
        by: actor,
        kind: "status",
        text: `Canceled: ${reason}`,
        internal: false,
        createdAt: now,
      });
      const card = rowToCard(this.getCardRow(id));
      const events: BoardEvent[] = [
        this.appendEvent({
          type: "card.canceled",
          cardId: id,
          mate: card.mate,
          holder: card.mate,
          actor,
          payload: { id: card.id, title: card.title, reason },
          createdAt: now,
        }),
        ...this.holdDependentsOfCanceled(card.id, now),
      ];
      return { result: card, events };
    });
  }

  public advertiseHost(input: AdvertiseHostInput): HostInfo {
    return this.runTransaction(() => {
      const now = this.nowFn();
      const repos = [...input.repos].toSorted();
      const event = this.appendEvent({
        type: "host.seen",
        cardId: null,
        mate: null,
        holder: null,
        actor: runnerActor(input.host),
        payload: {
          host: input.host,
          mode: input.mode,
          viewport: input.viewport,
          repos,
        },
        createdAt: now,
      });
      return {
        result: {
          host: input.host,
          mode: input.mode,
          viewport: input.viewport,
          repos,
          updatedAt: now,
        },
        events: [event],
      };
    });
  }

  public listHosts(): HostInfo[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM events
         WHERE id IN (
           SELECT MAX(id) FROM events WHERE type = 'host.seen'
           GROUP BY json_extract(payload_json, '$.host')
         )`,
      )
      .all();
    const hosts: HostInfo[] = [];
    for (const raw of rows) {
      const event = rowToEvent(raw);
      const parsed = HostPayloadSchema.safeParse(event.payload);
      if (!parsed.success) continue;
      hosts.push({
        host: parsed.data.host,
        mode: parsed.data.mode,
        viewport: parsed.data.viewport,
        repos: parsed.data.repos,
        updatedAt: event.createdAt,
      });
    }
    return hosts.toSorted((a, b) => a.host.localeCompare(b.host));
  }

  public listEventsSince(afterId: number, limit = 200): BoardEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?")
      .all(afterId, limit);
    return rows.map((row) => rowToEvent(row));
  }

  public latestEventId(): number {
    const raw = this.db.prepare("SELECT MAX(id) AS max_id FROM events").get();
    const val: unknown = raw !== undefined ? Reflect.get(raw, "max_id") : 0;
    return typeof val === "number" ? val : 0;
  }

  public sweepStale(staleAfterMs: number): BoardEvent[] {
    return this.runTransaction(() => {
      const now = this.nowFn();
      const events = this.expireLeasesInternal(now);
      const cutoff = now - staleAfterMs;
      const staleRows = this.db
        .prepare(
          `${CARD_SELECT}
           WHERE ((c.state = 'held' AND c.holder != 'captain') OR c.state = 'queued')
           AND c.updated_at <= ?
           ORDER BY c.updated_at ASC`,
        )
        .all(cutoff);

      const grouped = new Map<
        string,
        {
          readonly id: string;
          readonly title: string;
          readonly state: CardState;
          readonly ageMs: number;
        }[]
      >();

      for (const raw of staleRows) {
        const row = CardRowSchema.parse(raw);
        const targetHolder = row.state === "queued" ? row.mate : row.holder;
        const list = grouped.get(targetHolder) ?? [];
        list.push({
          id: String(row.id),
          title: row.title,
          state: row.state,
          ageMs: Math.max(0, now - row.updated_at),
        });
        grouped.set(targetHolder, list);
      }

      for (const [holder, cards] of grouped) {
        events.push(
          this.appendEvent({
            type: "chase.due",
            cardId: null,
            mate: holder,
            holder,
            actor: SERVER_ACTOR,
            payload: { holder, cards },
            createdAt: now,
          }),
        );
      }

      return { result: events, events };
    });
  }

  public getOverview(): BoardOverview {
    const counts = {
      total: 0,
      open: 0,
      needsCaptain: 0,
      held: 0,
      running: 0,
      queued: 0,
      waiting: 0,
      done: 0,
      canceled: 0,
    };
    const grouped = this.db
      .prepare(
        "SELECT state, holder = 'captain' AS captain, COUNT(*) AS n FROM cards GROUP BY state, captain",
      )
      .all();
    for (const raw of grouped) {
      const state = CardStateSchema.parse(Reflect.get(raw, "state"));
      const n = z.number().int().parse(Reflect.get(raw, "n"));
      counts.total += n;
      counts[state] += n;
      if (state !== "done" && state !== "canceled") counts.open += n;
      if (state === "held" && Reflect.get(raw, "captain") === 1) counts.needsCaptain += n;
    }
    return {
      counts,
      hosts: this.listHosts(),
      cards: this.listCards({ state: "open" }).cards,
    };
  }

  public getCharter(mate: string): string {
    const safe = parseMateName(mate);
    if (this.dataDir === undefined) {
      return this.memoryCharters.get(safe) ?? "";
    }
    const path = join(this.dataDir, "charters", `${safe}.md`);
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }

  public setCharter(mate: string, text: string): string {
    const safe = parseMateName(mate);
    if (this.dataDir === undefined) {
      this.memoryCharters.set(safe, text);
      return text;
    }
    const dir = join(this.dataDir, "charters");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${safe}.md`), text, "utf8");
    return text;
  }

  public getPrefs(): string {
    if (this.dataDir === undefined) return this.memoryPrefs;
    const path = join(this.dataDir, "prefs.md");
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }

  public setPrefs(text: string): string {
    if (this.dataDir === undefined) {
      this.memoryPrefs = text;
      return text;
    }
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(join(this.dataDir, "prefs.md"), text, "utf8");
    return text;
  }
}
