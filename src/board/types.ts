import { z } from "zod";

export const CARD_STATES = ["waiting", "queued", "running", "held", "done", "canceled"] as const;
export type CardState = (typeof CARD_STATES)[number];

export const DELIVERIES = ["no-mistakes", "direct-pr", "local", "ops"] as const;
export type Delivery = (typeof DELIVERIES)[number];

export const ENTRY_KINDS = ["reply", "status", "escalation", "answer", "chase"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export const EVENT_TYPES = [
  "card.created",
  "card.queued",
  "card.claimed",
  "card.expired",
  "card.returned",
  "card.escalated",
  "card.handed_off",
  "card.answered",
  "card.done",
  "card.canceled",
  "entry.posted",
  "chase.due",
  "host.seen",
] as const;
export type BoardEventType = (typeof EVENT_TYPES)[number];

export const CardSchema = z.object({
  id: z.string(),
  mate: z.string(),
  title: z.string(),
  body: z.string(),
  state: z.enum(CARD_STATES),
  holder: z.string(),
  project: z.string().nullable(),
  host: z.string().nullable(),
  delivery: z.enum(DELIVERIES).nullable(),
  needs: z.array(z.string()),
  labels: z.record(z.string(), z.string()),
  result: z.string(),
  epoch: z.number().int(),
  claimBy: z.string().nullable(),
  leaseUntil: z.number().int().nullable(),
  createdBy: z.string(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  entryCount: z.number().int(),
});
export type Card = z.infer<typeof CardSchema>;

export const EntrySchema = z.object({
  id: z.string(),
  cardId: z.string(),
  by: z.string(),
  kind: z.enum(ENTRY_KINDS),
  text: z.string(),
  internal: z.boolean(),
  createdAt: z.number().int(),
});
export type Entry = z.infer<typeof EntrySchema>;

export const CardThreadSchema = z.object({
  card: CardSchema,
  entries: z.array(EntrySchema),
});
export type CardThread = z.infer<typeof CardThreadSchema>;

export const HostInfoSchema = z.object({
  host: z.string(),
  mode: z.string(),
  viewport: z.string(),
  repos: z.array(z.string()),
  updatedAt: z.number().int(),
});
export type HostInfo = z.infer<typeof HostInfoSchema>;

export const ClaimReceiptSchema = z.object({
  card: CardSchema,
  epoch: z.number().int(),
  token: z.string(),
  leaseUntil: z.number().int(),
});
export type ClaimReceipt = z.infer<typeof ClaimReceiptSchema>;

export const BoardEventSchema = z.object({
  id: z.number().int(),
  type: z.enum(EVENT_TYPES),
  cardId: z.string().nullable(),
  mate: z.string().nullable(),
  holder: z.string().nullable(),
  actor: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.number().int(),
});
export type BoardEvent = z.infer<typeof BoardEventSchema>;

export const OverviewSchema = z.object({
  counts: z.object({
    total: z.number().int(),
    open: z.number().int(),
    needsCaptain: z.number().int(),
    held: z.number().int(),
    running: z.number().int(),
    queued: z.number().int(),
    waiting: z.number().int(),
    done: z.number().int(),
    canceled: z.number().int(),
  }),
  hosts: z.array(HostInfoSchema),
  cards: z.array(CardSchema),
  parents: z.record(z.string(), z.string()),
});
export type BoardOverview = z.infer<typeof OverviewSchema>;

export class BoardError extends Error {
  public readonly status: number;
  public readonly code: string;

  public constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "BoardError";
    this.status = status;
    this.code = code;
  }
}

export interface CreateCardInput {
  readonly mate: string;
  readonly title: string;
  readonly body?: string;
  readonly project?: string;
  readonly host?: string;
  readonly delivery?: Delivery;
  readonly needs?: readonly string[];
  readonly labels?: Readonly<Record<string, string>>;
  readonly holder?: string;
  readonly actor?: string;
}

export interface ListCardsQuery {
  readonly mate?: string;
  readonly holder?: string;
  readonly state?: CardState | "open" | "all";
  readonly limit?: number;
}

export interface QueueCardInput {
  readonly project?: string;
  readonly host?: string;
  readonly delivery?: Delivery;
  readonly actor?: string;
}

export interface ClaimNextInput {
  readonly host: string;
  readonly mates?: readonly string[];
  readonly leaseSeconds: number;
  readonly claimBy: string;
  readonly waitSeconds?: number;
}

export interface ClaimFenceInput {
  readonly epoch: number;
  readonly token: string;
}

export interface FinishClaimInput extends ClaimFenceInput {
  readonly outcome: "done" | "needs_mate";
  readonly summary: string;
  readonly actor?: string;
  readonly kind?: string;
}

export interface PostEntryInput {
  readonly text: string;
  readonly by?: string;
  readonly internal?: boolean;
  readonly kind?: EntryKind;
}

export interface EscalateCardInput {
  readonly reason: string;
  readonly to?: string;
  readonly actor?: string;
  readonly kind?: string;
}

export interface HandoffCardInput {
  readonly to?: string;
  readonly text?: string;
  readonly actor?: string;
  readonly internal?: boolean;
}

export interface AnswerCardInput {
  readonly text: string;
  readonly to?: string;
  readonly actor?: string;
}

export interface CloseCardInput {
  readonly result?: string;
  readonly actor?: string;
}

export interface CancelCardInput {
  readonly reason: string;
  readonly actor?: string;
}

export interface AdvertiseHostInput {
  readonly host: string;
  readonly mode: string;
  readonly viewport: string;
  readonly repos: readonly string[];
}
